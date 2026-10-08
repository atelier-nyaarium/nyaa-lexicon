// Turning a TypeScript AST into protocol facts.
//
// No parser here: the TypeScript compiler owns that, which is the whole reason the provider seam
// is a process boundary. This file only maps its tree onto our vocabulary.

import {
	composeSymbolId,
	type Declaration,
	type Descriptor,
	defined,
	type Export,
	type FileRole,
	type Import,
	type Literal,
	type Reference,
	RUNNING_KINDS,
	type WorkMeter,
} from "@nyaa-lexicon/protocol";
import ts from "typescript";
import {
	anonymousDefaultExportOf,
	boundNames,
	type Classified,
	classify,
	exportsImplicitly,
	isExported,
	isGlobalBlock,
	isRunningBody,
	loopHeadOf,
	nameOf,
	visibilityOf,
} from "./declarations.js";
import { moduleEdges } from "./edges.js";
import { fileRoleOf } from "./file-role.js";
import { scriptKindOf } from "./file-types.js";
import { headerOf } from "./header.js";
import { literalOf } from "./literals.js";
import {
	isWrapper,
	memberBodyOf,
	memberInsertLineOf,
	ownedTypeLiterals,
	partsOf,
	passesReach,
	statedObjectOf,
	unwrapped,
} from "./members.js";
import { metricsOf } from "./metrics.js";
import { declarationRangeOf, defaultSelectionRange, nameRange, parameterRangeOf, rangeOf } from "./ranges.js";
import {
	isConstAssertionType,
	isContextualPropertyReference,
	isDeclarationName,
	isModuleMemberShorthand,
	isQualifiedReference,
	isReferenceNode,
	type ReferenceNode,
	type ReferenceRole,
	referenceTarget,
	rolesForIdentifier,
} from "./references.js";

////////////////////////////////
//  Constants

export const LANGUAGE = "typescript";

/** The checker's name for what `export =` exports. */
export const EXPORT_EQUALS = "export=";

////////////////////////////////
//  Interfaces & Types

export interface Extracted {
	declarations: Declaration[];
	references: Reference[];
	imports: Import[];
	exports: Export[];
	literals: Literal[];
	role: FileRole;
}

export interface ExtractedWithNodes extends Extracted {
	declarationNodes: Map<ts.Node, string>;
}

/** A declaration's own descriptor plus the chain it sits under, so ids nest correctly. */
interface Scope {
	descriptors: Descriptor[];
	containerId: string | undefined;
	/** Inside a running body. */
	runs?: true;
	/** Under a declaration a running body holds, so what is declared here never leaves it either. */
	hidden?: true;
}

////////////////////////////////
//  Functions & Helpers

/**
 * Walk a file into declarations and references.
 *
 * Exported-ness is taken from the modifier only. A re-export through a barrel is not syntactic,
 * and claiming otherwise here would be exactly the confident-wrong-answer the design refuses.
 */
export function extractFile(
	module: string,
	source: ts.SourceFile,
	checker?: ts.TypeChecker,
	meter?: WorkMeter,
): Extracted {
	const extracted = extractFileWithNodes(module, source, checker, meter);
	return {
		declarations: extracted.declarations,
		references: extracted.references,
		imports: extracted.imports,
		exports: extracted.exports,
		literals: extracted.literals,
		role: extracted.role,
	};
}

export function extractFileWithNodes(
	module: string,
	source: ts.SourceFile,
	checker?: ts.TypeChecker,
	meter?: WorkMeter,
): ExtractedWithNodes {
	const declarations: Declaration[] = [];
	const references: Reference[] = [];
	const literals: Literal[] = [];
	const declarationNodes = new Map<ts.Node, string>();
	const declarationScopes = new Map<ts.Node, Scope>();
	const ordinals = new Map<string, number>();
	/** Declarations per name path, keyed by the first one's id. */
	const minted = new Map<string, number>();
	const referenceRoles = new Map<ts.Node, ReferenceRole[]>();
	/** Containers with something declared while running. */
	const running = new Set<string>();
	/** Where each constructor sits, which is where its parameter properties sit. */
	const constructorHomes = new Map<ts.Node, Scope>();
	/** A named parameter's declared type, whose object members sit under the parameter. */
	const typeScopes = new Map<ts.Node, Scope>();
	/** Each declaration's own object types, read once however many members ask. */
	const ownedLiterals = new Map<ts.Node, Set<ts.Node>>();

	/** Whether each declared node leaves its module, which its members inherit. */
	const reach = new Map<ts.Node, boolean>();

	function declare(node: ts.Node, declaration: Declaration): void {
		declarationNodes.set(node, declaration.symbolId);
		reach.set(node, declaration.exported === true);
		declarations.push(declaration);
	}

	function noteDeclaredIn(scope: Scope): void {
		if (scope.runs === true && scope.containerId !== undefined) running.add(scope.containerId);
	}

	/** The recorded declaration holding an object or class expression as its member body. */
	function holderOf(body: ts.Node): ts.Node | undefined {
		let value = body;
		while (isWrapper(value.parent)) value = value.parent;
		const holder = value.parent;
		return declarationNodes.has(holder) && memberBodyOf(holder) === body ? holder : undefined;
	}

	/** A member of a type literal, object or class expression counts only where a recorded declaration owns it. */
	function isOwnedMember(node: ts.Node): boolean {
		const literal = node.parent;
		if (ts.isObjectLiteralExpression(literal) || ts.isClassExpression(literal)) {
			return holderOf(literal) !== undefined;
		}
		if (!ts.isTypeLiteralNode(literal)) return true;
		let owner = literal.parent;
		while (partsOf(owner) !== undefined) owner = owner.parent;
		if (!declarationNodes.has(owner)) return false;
		let owned = ownedLiterals.get(owner);
		if (owned === undefined) {
			owned = new Set(ownedTypeLiterals(owner, meter));
			ownedLiterals.set(owner, owned);
		}
		return owned.has(literal);
	}

	/** A property of an object a declaration owns: any in a typed object, else one holding members or a body. */
	function isObjectMember(node: ts.Node): boolean {
		if (!ts.isPropertyAssignment(node) && !ts.isShorthandPropertyAssignment(node)) return false;
		const holder = holderOf(node.parent);
		if (holder === undefined) return false;
		if (statedObjectOf(holder) === node.parent) return true;
		if (!ts.isPropertyAssignment(node)) return false;
		const held = unwrapped(node.initializer);
		return ts.isArrowFunction(held) || ts.isFunctionExpression(held) || memberBodyOf(node) !== undefined;
	}

	function markReference(node: ts.Node, role: ReferenceRole): void {
		if (!isReferenceNode(node)) return;
		const roles = referenceRoles.get(node) ?? [];
		if (!roles.includes(role)) roles.push(role);
		referenceRoles.set(node, roles);
	}

	function classifyReferenceTree(node: ts.Node, inType: boolean): void {
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
		if (ts.isHeritageClause(node)) {
			const role = node.token === ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements";
			for (const type of node.types) {
				const target = referenceTarget(type.expression);
				if (target === undefined) classifyReferenceTree(type.expression, false);
				else markReference(target, role);
				for (const argument of type.typeArguments ?? []) classifyReferenceTree(argument, true);
			}
			return;
		}
		if (checker !== undefined && isContextualPropertyReference(node, checker)) {
			markReference(node, "read");
			return;
		}
		if (checker !== undefined && ts.isIdentifier(node) && isModuleMemberShorthand(node, checker)) {
			markReference(node, "read");
			return;
		}
		if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
			if (isConstAssertionType(node) || isDeclarationName(node)) return;
			const roles: ReferenceRole[] = inType ? ["typeUse"] : rolesForIdentifier(node);
			for (const role of roles) markReference(node, role);
			return;
		}
		const childInType = inType || ts.isTypeNode(node);
		ts.forEachChild(node, (child) => classifyReferenceTree(child, childInType));
	}

	// Only a method renders a disambiguator, so only methods count overloads.
	function descriptorFor(scope: Scope, descriptor: Descriptor): Descriptor {
		if (descriptor.kind !== "method") return descriptor;
		const prefix = scope.descriptors.map((item) => `${item.kind}:${item.name}`).join("/");
		const key = `${prefix}/${descriptor.kind}:${descriptor.name}`;
		const ordinal = ordinals.get(key) ?? 0;
		ordinals.set(key, ordinal + 1);
		return ordinal === 0 ? descriptor : { ...descriptor, disambiguator: String(ordinal) };
	}

	/** A repeated name path takes its next occurrence here, so its members and bindings name it. */
	function mint(scope: Scope, descriptor: Descriptor): { descriptors: Descriptor[]; symbolId: string } {
		const own = descriptorFor(scope, descriptor);
		const first = composeSymbolId({ language: LANGUAGE, module, descriptors: [...scope.descriptors, own] });
		const seen = minted.get(first) ?? 0;
		minted.set(first, seen + 1);
		if (seen === 0) return { descriptors: [...scope.descriptors, own], symbolId: first };
		const descriptors = [...scope.descriptors, { ...own, occurrence: seen + 1 }];
		return { descriptors, symbolId: composeSymbolId({ language: LANGUAGE, module, descriptors }) };
	}

	function ownerScopeOfParameter(parameter: ts.ParameterDeclaration): Scope | undefined {
		const parent = parameter.parent;
		const direct = declarationScopes.get(parent);
		if (direct !== undefined) return direct;
		if (!ts.isArrowFunction(parent) && !ts.isFunctionExpression(parent)) return undefined;

		let expression: ts.Expression = parent;
		let current: ts.Node = parent;
		while (true) {
			const enclosing = current.parent;
			if (
				(ts.isParenthesizedExpression(enclosing) && enclosing.expression === expression) ||
				(ts.isAsExpression(enclosing) && enclosing.expression === expression) ||
				(ts.isTypeAssertionExpression(enclosing) && enclosing.expression === expression) ||
				(ts.isSatisfiesExpression(enclosing) && enclosing.expression === expression) ||
				(ts.isNonNullExpression(enclosing) && enclosing.expression === expression)
			) {
				expression = enclosing;
				current = enclosing;
				continue;
			}
			if (
				(ts.isVariableDeclaration(enclosing) ||
					ts.isPropertyDeclaration(enclosing) ||
					ts.isPropertyAssignment(enclosing)) &&
				(enclosing.initializer === expression || enclosing.initializer === current)
			) {
				return declarationScopes.get(enclosing);
			}
			return undefined;
		}
	}

	function recordParameters(parameter: ts.ParameterDeclaration, owner: Scope): void {
		for (const binding of boundNames(parameter)) {
			const { descriptors, symbolId } = mint(owner, { kind: "parameter", name: binding.name.text });
			if (binding.node === parameter && parameter.type !== undefined) {
				typeScopes.set(parameter.type, { descriptors, containerId: symbolId });
			}
			declare(binding.node, {
				symbolId,
				kind: "variable",
				name: binding.name.text,
				range: parameterRangeOf(binding.node, source),
				selectionRange: rangeOf(binding.name, source),
				visibility: "local",
				exported: false,
				...defined({ containerId: owner.containerId }),
			});
		}
	}

	/** One declaration, the class's property, for both of `constructor(private x)`'s names. */
	function recordParameterProperty(
		parameter: ts.ParameterPropertyDeclaration,
		home: Scope,
		reachable: boolean,
	): void {
		if (!ts.isIdentifier(parameter.name)) return;
		const name = parameter.name.text;
		const { descriptors, symbolId } = mint(home, { kind: "term", name });
		if (parameter.type !== undefined) typeScopes.set(parameter.type, { descriptors, containerId: symbolId });
		const range = parameterRangeOf(parameter, source);
		const visibility = home.runs === true || home.hidden === true ? "local" : visibilityOf(parameter, reachable);
		noteDeclaredIn(home);
		declare(parameter, {
			symbolId,
			kind: "property",
			name,
			range,
			selectionRange: rangeOf(parameter.name, source),
			visibility,
			exported: visibility === "public",
			metrics: { lines: range.end.line - range.start.line + 1 },
			...defined({ signature: headerOf(parameter, source, meter), containerId: home.containerId }),
		});
	}

	function record(node: ts.Node, scope: Scope, exportedByParent: boolean): Scope {
		if (ts.isParameter(node)) {
			const owner = ownerScopeOfParameter(node);
			if (owner === undefined) return scope;
			const home = constructorHomes.get(node.parent);
			if (home !== undefined && ts.isParameterPropertyDeclaration(node, node.parent)) {
				recordParameterProperty(node, home, exportedByParent);
			} else recordParameters(node, owner);
			return owner;
		}
		const anonymousDefault = anonymousDefaultExportOf(node);
		if (anonymousDefault !== undefined) {
			const name = ts.isExportAssignment(node) && node.isExportEquals ? EXPORT_EQUALS : "default";
			const { descriptors, symbolId } = mint(scope, { kind: anonymousDefault.descriptor, name });
			const range = declarationRangeOf(node, source);
			const signature = headerOf(node, source, meter);
			const defaultSpan = defaultSelectionRange(node, source);

			noteDeclaredIn(scope);
			declare(node, {
				symbolId,
				kind: anonymousDefault.kind,
				name,
				range,
				...(defaultSpan === undefined ? {} : { selectionRange: defaultSpan }),
				visibility: "public",
				exported: true,
				metrics: metricsOf(node, range),
				...defined({
					signature,
					containerId: scope.containerId,
					memberInsertLine: memberInsertLineOf(node, source),
				}),
			});

			const inner = { descriptors, containerId: symbolId };
			declarationScopes.set(node, inner);
			return inner;
		}
		const classified: Classified | null =
			classify(node) ?? (isObjectMember(node) ? { kind: "property", descriptor: "term" } : null);
		const name = classified ? nameOf(node) : null;
		if (!classified || name === null || !isOwnedMember(node)) return scope;

		const local = scope.runs === true || scope.hidden === true;
		const reachable = exportedByParent || isExported(node) || isGlobalBlock(node);
		const visibility = local ? "local" : visibilityOf(node, reachable);
		const { descriptors, symbolId } = mint(scope, { kind: classified.descriptor, name });
		const range = declarationRangeOf(node, source);

		noteDeclaredIn(scope);
		declare(node, {
			symbolId,
			kind: classified.kind,
			name,
			range,
			selectionRange: nameRange(node, source, (node as { name?: ts.Node }).name),
			visibility,
			// A private or protected member stays in its module.
			exported: visibility === "public",
			metrics: metricsOf(node, range),
			...defined({
				languageKind: classified.languageKind,
				signature: headerOf(node, source, meter),
				containerId: scope.containerId,
				memberInsertLine: memberInsertLineOf(node, source),
			}),
		});

		const inner: Scope = { descriptors, containerId: symbolId, ...(local ? { hidden: true } : {}) };
		declarationScopes.set(node, inner);
		if (ts.isConstructorDeclaration(node)) constructorHomes.set(node, scope);
		return inner;
	}

	/** Every name the declarations bind, each ranged as its whole `holder`. */
	function recordVariables(
		declarations: readonly ts.VariableDeclaration[],
		holder: ts.Node,
		scope: Scope,
		reachable: boolean,
	): void {
		const local = scope.runs === true || scope.hidden === true;
		const exported = !local && reachable;
		// `const` is a different kind from `let`, and a consumer deciding whether something can be
		// reassigned reads the kind rather than re-parsing the declaration.
		const list = declarations[0]?.parent;
		const isConst =
			list !== undefined && ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
		const range = declarationRangeOf(holder, source);

		for (const declaration of declarations) {
			const signature = headerOf(declaration, source, meter);
			for (const binding of boundNames(declaration)) {
				const name = binding.name.text;
				const { descriptors, symbolId } = mint(scope, { kind: "term", name });
				declarationScopes.set(binding.node, {
					descriptors,
					containerId: symbolId,
					...(local ? { hidden: true } : {}),
				});

				noteDeclaredIn(scope);
				declare(binding.node, {
					symbolId,
					kind: isConst ? "constant" : "variable",
					name,
					range,
					selectionRange: rangeOf(binding.name, source),
					visibility: local ? "local" : exported ? "public" : "fileLocal",
					exported,
					metrics: metricsOf(binding.node, range),
					...defined({
						signature,
						containerId: scope.containerId,
						memberInsertLine: memberInsertLineOf(binding.node, source),
					}),
				});
			}
		}
	}

	function recordReference(node: ReferenceNode, role: ReferenceRole, scope: Scope): void {
		references.push({
			name: node.text,
			range: rangeOf(node, source),
			role,
			binding: { status: "unbound", reason: "NotImplemented", detail: "binding runs in the bind tier" },
			qualified: isQualifiedReference(node),
			...defined({ fromId: scope.containerId }),
		});
	}

	function walk(node: ts.Node, scope: Scope, exportedByParent: boolean): void {
		if (ts.isVariableStatement(node)) {
			const { declarations } = node.declarationList;
			recordVariables(declarations, node, scope, exportedByParent || isExported(node));
		}
		const head = loopHeadOf(node);
		if (head !== undefined) recordVariables(head.declarations, head, scope, false);
		if (ts.isCatchClause(node) && node.variableDeclaration !== undefined) {
			recordVariables([node.variableDeclaration], node.variableDeclaration, scope, false);
		}
		const literal = literalOf(node, source, declarationNodes);
		if (literal !== undefined) literals.push(literal);
		if (isReferenceNode(node)) {
			for (const role of referenceRoles.get(node) ?? []) recordReference(node, role, scope);
		}

		const recorded = record(node, scope, exportedByParent);
		const inner = declarationScopes.get(node) ?? typeScopes.get(node) ?? recorded;
		// A member of a reachable container is reachable, so its own lack of `export` is not privacy.
		// A declared type passes its owner's reach to the members of its object types.
		const childrenExported =
			inner !== scope
				? (reach.get(node) ?? (exportedByParent || isExported(node)))
				: exportsImplicitly(node) || (exportedByParent && passesReach(node));
		// Parameters keep the owner's running flag.
		const runs = isRunningBody(node) || (ts.isParameter(node) && scope.runs === true);
		const childScope: Scope = runs ? { ...inner, runs: true } : inner;
		ts.forEachChild(node, (child) => walk(child, childScope, childrenExported));
	}

	classifyReferenceTree(source, false);
	walk(source, { descriptors: [], containerId: undefined }, false);
	// Kind already implies it.
	for (const declaration of declarations) {
		if (running.has(declaration.symbolId) && !RUNNING_KINDS.has(declaration.kind)) declaration.contains = "locals";
	}
	const kind = scriptKindOf(module);
	const edges = moduleEdges(source, {
		idsOf: (node) => {
			const id = declarationNodes.get(node);
			return id === undefined ? [] : [id];
		},
		checker,
		javascript: kind === ts.ScriptKind.JS || kind === ts.ScriptKind.JSX,
	});
	const uses = withoutTransferNames(references, edges.imports);
	return { declarations, ...edges, references: uses, literals, role: fileRoleOf(source), declarationNodes };
}

/** An import edge's own source name is the transfer, never a use. */
function withoutTransferNames(references: Reference[], imports: readonly Import[]): Reference[] {
	const key = ({ start, end }: Reference["range"]) => `${start.line}:${start.character}-${end.line}:${end.character}`;
	const names = new Set(
		imports.flatMap((statement) =>
			statement.edges.flatMap((edge) => (edge.range === undefined ? [] : [key(edge.range)])),
		),
	);
	return names.size === 0 ? references : references.filter((reference) => !names.has(key(reference.range)));
}
