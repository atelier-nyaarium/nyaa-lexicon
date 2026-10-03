// The imports a moved body needs where it lands, against what that module already binds.

import path from "node:path";
import type {
	ImportKind,
	MoveBlockedSite,
	MoveDependency,
	MoveEditsRequest,
	OffsetRange,
} from "@nyaa-lexicon/protocol";
import ts from "typescript";
import { EXPORT_EQUALS } from "./extract.js";
import { scriptKindOf } from "./file-types.js";
import { importOf } from "./imports.js";
import { append, blockedSite, type LandingKey, type PlannedImport } from "./move-imports.js";
import type { SpecifierRenderer } from "./project.js";
import { isDeclarationName, isQualifiedReference, meaningAt } from "./references.js";

////////////////////////////////
//  Interfaces & Types

/** What binds one module-scope name: an import in some form, or a declaration when `specifier` is absent. */
export interface ModuleBinding {
	specifier?: string;
	form?: ImportKind;
	/** The export a named import takes. */
	imported?: string;
	typeOnly: boolean;
}

////////////////////////////////
//  Constants

const BUILTIN_NAMES = new Set([
	"any",
	"Array",
	"ArrayBuffer",
	"ArrayBufferView",
	"ArrayLike",
	"AsyncIterable",
	"AsyncIterableIterator",
	"Awaited",
	"bigint",
	"BigInt",
	"BigInt64Array",
	"BigUint64Array",
	"boolean",
	"Boolean",
	"CallableFunction",
	"Capitalize",
	"console",
	"ConstructorParameters",
	"DataView",
	"Date",
	"document",
	"Element",
	"Error",
	"Event",
	"Exclude",
	"Extract",
	"false",
	"Float32Array",
	"Float64Array",
	"FormData",
	"Function",
	"Generator",
	"GeneratorFunction",
	"Headers",
	"HTMLElement",
	"HTMLInputElement",
	"HTMLTextAreaElement",
	"Infinity",
	"InstanceType",
	"Int16Array",
	"Int32Array",
	"Int8Array",
	"Iterable",
	"IterableIterator",
	"Iterator",
	"JSON",
	"Map",
	"Math",
	"MessageEvent",
	"MouseEvent",
	"never",
	"NonNullable",
	"NoInfer",
	"Node",
	"Number",
	"Object",
	"Omit",
	"OmitThisParameter",
	"Partial",
	"Parameters",
	"Pick",
	"Promise",
	"PromiseLike",
	"PropertyKey",
	"Record",
	"Readonly",
	"ReadonlyArray",
	"ReadonlyMap",
	"ReadonlySet",
	"RegExp",
	"Required",
	"ReturnType",
	"Set",
	"SharedArrayBuffer",
	"String",
	"Symbol",
	"SymbolConstructor",
	"ThisParameterType",
	"ThisType",
	"true",
	"Uint16Array",
	"Uint32Array",
	"Uint8Array",
	"Uint8ClampedArray",
	"undefined",
	"Uncapitalize",
	"UnicodeNormalizationForm",
	"unknown",
	"URL",
	"URLSearchParams",
	"Uppercase",
	"WeakMap",
	"WeakSet",
	"Window",
	"XMLHttpRequest",
	"void",
]);

////////////////////////////////
//  Dependency Imports

/** How a module writes one dependency's import. */
export interface ImportStyle {
	render: SpecifierRenderer;
	landingKey: LandingKey;
	/** The module runs as an ECMAScript module. */
	esm: boolean;
	/** The module uses the dependency only as a type. */
	typeOnly: boolean;
}

export function importForDependency(
	request: Pick<MoveEditsRequest, "module" | "fromModule">,
	dependency: MoveDependency,
	source: ts.SourceFile,
	checker: ts.TypeChecker | undefined,
	bindings: Map<string, ModuleBinding[]>,
	{ render: renderSpecifier, landingKey, esm, typeOnly }: ImportStyle,
): { planned?: PlannedImport; blocked?: MoveBlockedSite } {
	if (isBuiltinName(dependency.name, checker, source)) return {};

	const origin = dependency.origin;
	if (origin.kind === "insideClosure") return {};
	if (origin.kind === "unresolved") {
		return {
			blocked: blockedSite(dependency.range, "DynamicDependency", origin.reason),
		};
	}
	if (origin.kind === "sourceModule" && origin.exported === false) {
		return {
			blocked: blockedSite(dependency.range, "PrivateSibling", `${origin.name} is not exported`),
		};
	}

	let specifier: string;
	let preferred: string | undefined;
	if (origin.kind === "sourceModule" || origin.kind === "workspaceModule") {
		const home = origin.kind === "sourceModule" ? request.fromModule : origin.module;
		// Declared here already.
		if (sameModulePath(home, request.module)) return {};
		preferred = origin.kind === "workspaceModule" ? origin.via?.specifier : undefined;
		const rendered = renderSpecifier(request.module, home, preferred);
		if ("reason" in rendered) return { blocked: blockedSite(dependency.range, rendered.reason, rendered.detail) };
		specifier = rendered.specifier;
	} else {
		specifier = origin.via.specifier;
	}

	const planned = plannedImport(dependency, specifier, typeOnly);
	if (planned === undefined) {
		return {
			blocked: blockedSite(dependency.range, "NotImplemented", "the import form cannot bind a moved dependency"),
		};
	}
	const kind = scriptKindOf(request.module);
	const script = kind === ts.ScriptKind.JS || kind === ts.ScriptKind.JSX;
	// A type-only one erases, so an ECMAScript module may write it.
	if (planned.clause === "require" && (script || (esm && !planned.typeOnly))) {
		return {
			blocked: blockedSite(
				dependency.range,
				"NotImplemented",
				`${planned.localName} comes from \`import ${planned.localName} = require()\`, which ${script ? "JavaScript" : "an ECMAScript module"} cannot write`,
			),
		};
	}
	const existing = bindings.get(planned.localName);
	if (existing === undefined) return { planned };
	if (existing.every((binding) => bindsPlanned(binding, planned, landingKey))) return {};
	return {
		blocked: blockedSite(
			dependency.range,
			"TargetCollision",
			`the target already binds ${planned.localName} to something else; rename one of them first`,
		),
	};
}

/** The existing import brings in what the plan would, usable wherever the plan is. */
export function bindsPlanned(binding: ModuleBinding, planned: PlannedImport, landingKey: LandingKey): boolean {
	if (binding.specifier === undefined || landingKey(binding.specifier) !== landingKey(planned.specifier))
		return false;
	if (binding.typeOnly && !planned.typeOnly) return false;
	if (binding.form !== planned.clause) return false;
	return planned.clause !== "named" || binding.imported === planned.importedName;
}

function plannedImport(dependency: MoveDependency, specifier: string, typed: boolean): PlannedImport | undefined {
	const origin = dependency.origin;
	const via = origin.kind === "workspaceModule" || origin.kind === "external" ? origin.via : undefined;
	const importedName = via?.importedName ?? dependency.name;
	const localName = dependency.name;
	const typeOnly = typed || via?.typeOnly === true;

	if (via?.importKind === "wildcard" || via?.importKind === "sideEffect") return undefined;
	if (via?.importKind === "require") return { clause: "require", typeOnly, specifier, localName };
	if (via?.importKind === "default" || via?.importKind === "namespace") {
		if (localName === "default") return undefined;
		return { clause: via.importKind, typeOnly, specifier, localName };
	}
	return { clause: "named", typeOnly, specifier, importedName, localName };
}

/**
 * The `names` written only in type positions, across the module's statements outside `removed` and
 * the text landing in it. A name with no use, or one whose meaning is ambiguous, is not one.
 */
export function typeOnlyNames(
	module: string,
	source: ts.SourceFile,
	removed: readonly OffsetRange[],
	landings: readonly string[],
	names: ReadonlySet<string>,
): Set<string> {
	if (names.size === 0) return new Set();
	const typed = new Map<string, boolean>();
	const visit = (node: ts.Node, skip: (node: ts.Node) => boolean): void => {
		if (
			ts.isImportDeclaration(node) ||
			ts.isImportEqualsDeclaration(node) ||
			(ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined)
		) {
			return;
		}
		if (ts.isIdentifier(node)) {
			if (!names.has(node.text) || isDeclarationName(node) || isQualifiedReference(node) || skip(node)) return;
			const type = useMeaning(node) === "type" && !inDecoratedClass(node);
			typed.set(node.text, (typed.get(node.text) ?? true) && type);
			return;
		}
		ts.forEachChild(node, (child) => visit(child, skip));
	};
	visit(source, (node) => {
		const at = node.getStart(source);
		return removed.some((span) => span.start <= at && at < span.end);
	});
	for (const text of landings) {
		visit(ts.createSourceFile(module, text, ts.ScriptTarget.ESNext, true, scriptKindOf(module)), () => false);
	}
	return new Set([...typed].flatMap(([name, type]) => (type ? [name] : [])));
}

/** A use's meaning, reading the head of a path through a type, such as `ns` in `ns.Shape`, as a type. */
function useMeaning(node: ts.Identifier): "value" | "type" | undefined {
	const meaning = meaningAt(node);
	if (meaning !== undefined) return meaning;
	let entity: ts.Node = node;
	while (
		(ts.isQualifiedName(entity.parent) && entity.parent.left === entity) ||
		(ts.isPropertyAccessExpression(entity.parent) && entity.parent.expression === entity)
	) {
		entity = entity.parent;
	}
	return entity !== node && ts.isPartOfTypeNode(entity) ? "type" : undefined;
}

/** Inside a class something decorates, whose signatures `emitDecoratorMetadata` emits as values. */
function inDecoratedClass(node: ts.Node): boolean {
	const decorated = (each: ts.Node) => ts.canHaveDecorators(each) && (ts.getDecorators(each)?.length ?? 0) > 0;
	for (let current = node.parent; current !== undefined; current = current.parent) {
		if (!ts.isClassLike(current)) continue;
		return (
			decorated(current) ||
			current.members.some(
				(member) => decorated(member) || (ts.isFunctionLike(member) && member.parameters.some(decorated)),
			)
		);
	}
	return false;
}

/** Every name the module's scope binds, with the import binding it, save what the move removes. */
export function moduleBindings(source: ts.SourceFile, removed: readonly OffsetRange[]): Map<string, ModuleBinding[]> {
	const bindings = new Map<string, ModuleBinding[]>();
	const bind = (name: string, binding: ModuleBinding) => append(bindings, name, binding);
	for (const statement of source.statements) {
		if (removed.some((span) => span.start <= statement.getStart(source) && statement.getEnd() <= span.end)) {
			continue;
		}
		const external =
			ts.isImportDeclaration(statement) ||
			(ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference));
		const imported = external ? importOf(statement, source) : undefined;
		if (imported !== undefined) {
			for (const edge of imported.edges) {
				const local = edge.local ?? edge.name;
				if (local === undefined || !edge.bindsLocally) continue;
				bind(local, {
					specifier: imported.specifier,
					form: edge.kind,
					...(edge.name === undefined ? {} : { imported: edge.name }),
					typeOnly: edge.typeOnly === true,
				});
			}
			continue;
		}
		if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				for (const name of boundIdentifiers(declaration.name)) bind(name, { typeOnly: false });
			}
			continue;
		}
		// A module has one slot for each.
		if (ts.isExportAssignment(statement)) {
			bind(statement.isExportEquals ? EXPORT_EQUALS : "default", { typeOnly: false });
			continue;
		}
		const name = (statement as { name?: ts.Node }).name;
		if (name !== undefined && ts.isIdentifier(name)) bind(name.text, { typeOnly: false });
		else for (const hoisted of hoistedVars(statement)) bind(hoisted, { typeOnly: false });
	}
	return bindings;
}

/** `var` names a top-level block, loop or branch declares, which hoist to module scope. */
function hoistedVars(statement: ts.Statement): string[] {
	const names: string[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
		if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.BlockScoped) === 0) {
			for (const declaration of node.declarations) names.push(...boundIdentifiers(declaration.name));
		}
		ts.forEachChild(node, visit);
	};
	visit(statement);
	return names;
}

export function boundIdentifiers(binding: ts.BindingName): string[] {
	if (ts.isIdentifier(binding)) return [binding.text];
	return binding.elements.flatMap((element) =>
		ts.isOmittedExpression(element) ? [] : boundIdentifiers(element.name),
	);
}

export function sameModulePath(left: string, right: string): boolean {
	return path.posix.normalize(left.replace(/\\/g, "/")) === path.posix.normalize(right.replace(/\\/g, "/"));
}

////////////////////////////////
//  Builtins

function isBuiltinName(name: string, checker: ts.TypeChecker | undefined, source: ts.SourceFile): boolean {
	if (BUILTIN_NAMES.has(name)) return true;
	if (checker === undefined) return false;
	try {
		const symbol = checker.resolveName(
			name,
			source,
			ts.SymbolFlags.Value | ts.SymbolFlags.Type | ts.SymbolFlags.Namespace,
			false,
		);
		if (symbol === undefined || symbol.declarations === undefined || symbol.declarations.length === 0) return false;
		return symbol.declarations.every((declaration) =>
			/(?:^|[\\/])lib\.[^\\/]+\.d\.ts$/.test(declaration.getSourceFile().fileName),
		);
	} catch {
		return false;
	}
}
