// One parsed file's declarations, and the passes that read them: scopes, references, inference and
// literals.

import type * as A from "../syntax/ast.js";
import { walk } from "../syntax/ast.js";
import { moduleExports, readAllList } from "./exports.js";
import { headerOf } from "./headers.js";
import { InferenceAnalyzer } from "./inference.js";
import { LiteralVisitor } from "./literals.js";
import { metricsOf } from "./metrics.js";
import {
	assignmentTargets,
	type Binder,
	isBinder,
	isDefinition,
	isFunction,
	isStringConstant,
	namesInTarget,
	nestedStatements,
	parameters,
	statementLists,
	wholeTargets,
	writtenParameters,
} from "./nodes.js";
import { ReferenceVisitor } from "./references.js";
import { fileRole } from "./role.js";
import { pathKey, Scopes } from "./scopes.js";
import type { Source } from "./source.js";
import type {
	Range,
	RawDeclaration,
	RawDescriptor,
	RawFacts,
	RawImport,
	RawImportBinding,
	RawImportStatement,
	RawReference,
	RawTypeAnnotation,
	ScopeKind,
} from "./types.js";

////////////////////////////////
//  Interfaces & Types

/** An annotation, with what its name resolves against until binding runs. */
interface PendingAnnotation extends RawTypeAnnotation {
	node: A.Expression;
	scopePath: RawDescriptor[];
}

export interface DeclaredNodes {
	path: RawDescriptor[];
	nodes: A.Node[];
}

type Declared = A.FunctionDef | A.ClassDef | A.TypeAlias;

////////////////////////////////
//  Constants

const TYPING_MODULES: ReadonlySet<string> = new Set(["typing", "typing_extensions"]);

////////////////////////////////
//  Functions & Helpers

export function descriptor(kind: RawDescriptor["kind"], name: string, disambiguator?: string): RawDescriptor {
	return disambiguator === undefined ? { kind, name } : { kind, name, disambiguator };
}

/** A path's identity with its disambiguators. */
export function identityKey(path: readonly RawDescriptor[]): string {
	let key = "";
	for (const item of path) key += `${item.kind} ${item.name} ${item.disambiguator ?? ""}/`;
	return key;
}

/** Where a declaration is stored: names, and a method's disambiguator. */
function storageKey(path: readonly RawDescriptor[]): string {
	let key = "";
	for (const item of path) key += `${item.name} ${item.kind === "method" ? (item.disambiguator ?? "") : ""}/`;
	return key;
}

function rangeKey(range: Range): string {
	return `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
}

function nameOf(node: Declared): string {
	return node.type === "TypeAlias" ? node.name.id : node.name;
}

function visibilityOf(name: string, kind: ScopeKind, exported: boolean): RawDeclaration["visibility"] {
	if (kind === "function") return "local";
	if (kind === "module") return exported ? "public" : "fileLocal";
	if (name.startsWith("__") && !name.endsWith("__")) return "private";
	return name.startsWith("_") ? "protected" : "public";
}

////////////////////////////////
//  Classes

export class Analyzer {
	/** One per storage key; a later same-named binding replaces an earlier one in place. */
	readonly declarations = new Map<string, RawDeclaration>();
	/** Every declaration, by its path's kinds and names. */
	readonly occurrences = new Map<string, RawDeclaration[]>();
	readonly declarationNodes = new Map<string, DeclaredNodes>();
	readonly references: RawReference[] = [];
	readonly imports: RawImport[] = [];
	readonly importStatements: RawImportStatement[] = [];
	readonly importBindings: RawImportBinding[] = [];
	exportNames: Set<string> | undefined;
	scopes!: Scopes;
	private readonly annotations: PendingAnnotation[] = [];
	private readonly annotationKeys = new Set<string>();
	private readonly declarationPaths = new Map<A.Node, RawDescriptor[]>();
	private readonly nodeScopePaths = new Map<A.Node, RawDescriptor[]>();
	private readonly descriptorCounts = new Map<string, number>();
	private finalNames = new Set<string>();
	private typeCheckingNames = new Set<string>();
	private typingModules = new Set<string>();

	constructor(
		readonly source: Source,
		readonly tree: A.Module,
	) {}

	////////////////////////////////
	//  Paths

	declarationPath(node: Declared, scope: RawDescriptor[], kind: RawDescriptor["kind"]): RawDescriptor[] {
		return this.declarationPaths.get(node) ?? [...scope, descriptor(kind, nameOf(node))];
	}

	/** The path a definition records, when it records one. */
	recordedPath(node: A.Node): RawDescriptor[] | undefined {
		return this.declarationPaths.get(node);
	}

	/** Every statement that binds a declaration. */
	nodesOf(declaration: RawDeclaration): A.Node[] {
		return this.declarationNodes.get(identityKey(declaration.descriptorPath))?.nodes ?? [];
	}

	typeAnnotations(): RawTypeAnnotation[] {
		return this.annotations;
	}

	/** A method's disambiguator counts same-named siblings before it. */
	private descriptorFor(scope: RawDescriptor[], value: RawDescriptor): RawDescriptor {
		const key = pathKey([...scope, value]);
		const ordinal = this.descriptorCounts.get(key) ?? 0;
		this.descriptorCounts.set(key, ordinal + 1);
		return ordinal === 0 ? value : { ...value, disambiguator: String(ordinal) };
	}

	////////////////////////////////
	//  Exports

	/** Names bound only to `typing` itself, or to its `Final` or `TYPE_CHECKING`, by direct module-level imports. */
	private findTypingBindings(): void {
		const bindings = new Map<string, Set<string>>();
		const record = (name: string, kind: string): void => {
			bindings.set(name, (bindings.get(name) ?? new Set()).add(kind));
		};
		for (const statements of statementLists(this.tree.body)) {
			const direct = statements === this.tree.body;
			const other = direct ? "other" : "conditional";
			for (const node of statements) {
				if (node.type === "Import") {
					for (const alias of node.names) {
						const local = alias.asname ?? (alias.name.split(".")[0] as string);
						record(local, direct && TYPING_MODULES.has(alias.name) ? "module" : other);
					}
				} else if (node.type === "ImportFrom") {
					const typing = direct && node.level === 0 && TYPING_MODULES.has(node.module ?? "");
					for (const alias of node.names) {
						if (alias.name === "*") continue;
						let kind = other;
						if (typing && alias.name === "Final") kind = "final";
						else if (typing && alias.name === "TYPE_CHECKING") kind = "typeChecking";
						record(alias.asname ?? alias.name, kind);
					}
				}
				const shadow = direct ? "shadow" : "conditional";
				if (isDefinition(node)) record(node.name, shadow);
				else if (isBinder(node)) for (const target of assignmentTargets(node)) record(target.id, shadow);
			}
		}
		const only = (kind: string): Set<string> =>
			new Set([...bindings].filter(([, kinds]) => kinds.size === 1 && kinds.has(kind)).map(([name]) => name));
		this.finalNames = only("final");
		this.typeCheckingNames = only("typeChecking");
		this.typingModules = only("module");
	}

	/** `member` read through a name bound only to it, or through a typing module. */
	private readsTyping(node: A.Expression, member: string, names: ReadonlySet<string>): boolean {
		if (node.type === "Name") return names.has(node.id);
		return (
			node.type === "Attribute" &&
			node.value.type === "Name" &&
			node.attr === member &&
			this.typingModules.has(node.value.id)
		);
	}

	private isFinalValue(node: A.Expression): boolean {
		return this.readsTyping(node, "Final", this.finalNames);
	}

	/** `TYPE_CHECKING`, which a static reading takes as true. */
	isTypeChecking(test: A.Expression): boolean {
		return this.readsTyping(test, "TYPE_CHECKING", this.typeCheckingNames);
	}

	/** Statements a static reading runs on load: the module body, and each `if TYPE_CHECKING:` body in it. */
	loadStatements(): Set<A.Node> {
		const found = new Set<A.Node>();
		const add = (statements: readonly A.Statement[]): void => {
			for (const node of statements) {
				found.add(node);
				if (node.type === "If" && this.isTypeChecking(node.test)) add(node.body);
			}
		};
		add(this.tree.body);
		return found;
	}

	private isFinalAnnotation(node: A.Node): boolean {
		if (node.type !== "AnnAssign") return false;
		const annotation = node.annotation;
		if (annotation.type === "Subscript") return this.isFinalValue(annotation.value);
		return this.isFinalValue(annotation);
	}

	isExported(name: string, moduleScope: boolean, parentExported: boolean): boolean {
		if (!moduleScope) return parentExported;
		if (this.exportNames !== undefined) return this.exportNames.has(name);
		return !name.startsWith("_");
	}

	////////////////////////////////
	//  Declarations

	private addTypeAnnotation(
		anchor: A.Node,
		annotation: A.Expression,
		scope: RawDescriptor[] = [],
	): string | undefined {
		const text = this.source.segment(annotation);
		if (text === "") return undefined;
		const anchorRange = this.source.selectionOf(anchor);
		const annotationRange = this.source.rangeOf(annotation);
		const key = `${rangeKey(anchorRange)} ${rangeKey(annotationRange)} ${text}`;
		if (!this.annotationKeys.has(key)) {
			this.annotationKeys.add(key);
			this.annotations.push({
				anchorRange,
				annotationRange,
				text,
				forwardReference: isStringConstant(annotation),
				node: annotation,
				scopePath: [...scope],
			});
		}
		return text;
	}

	private addDeclaration(
		node: A.Node,
		selection: A.Node,
		name: string,
		kind: RawDeclaration["kind"],
		path: RawDescriptor[],
		scopeKind: ScopeKind,
		moduleScope: boolean,
		parentExported: boolean,
		whole = true,
		item?: A.WithItem,
	): void {
		const exported = this.isExported(name, moduleScope, parentExported);
		const range = this.source.range(this.source.declarationStart(node), node.end);
		const raw: RawDeclaration = {
			name,
			kind,
			descriptorPath: path,
			containerPath: path.slice(0, -1),
			range,
			selectionRange: this.source.selectionOf(selection),
			visibility: visibilityOf(name, scopeKind, exported),
			exported,
		};
		if (
			node.type !== "arg" &&
			node.type !== "TypeVar" &&
			node.type !== "ParamSpec" &&
			node.type !== "TypeVarTuple"
		) {
			const header = headerOf(this.source, node, selection, whole, item);
			if (header !== undefined) raw.header = header;
			raw.metrics = metricsOf(node, range);
		}
		if (node.type === "ClassDef") {
			const line = this.source.memberInsertLine(node);
			if (line !== undefined) raw.memberInsertLine = line;
		}
		let annotation: A.Expression | undefined;
		let anchor: A.Node = node;
		if (isFunction(node)) annotation = node.returns;
		else if (node.type === "AnnAssign") {
			annotation = node.annotation;
			anchor = selection;
		}
		if (annotation !== undefined) {
			const text = this.addTypeAnnotation(anchor, annotation, path.slice(0, -1));
			if (text !== undefined) {
				raw.typeText = text;
				raw.typeForwardReference = isStringConstant(annotation);
			}
		}
		const occurrences = this.occurrences.get(pathKey(path)) ?? [];
		occurrences.push(raw);
		this.occurrences.set(pathKey(path), occurrences);
		this.declarations.set(storageKey(path), raw);
		const identity = identityKey(path);
		const declared = this.declarationNodes.get(identity) ?? { path, nodes: [] };
		declared.nodes.push(node);
		this.declarationNodes.set(identity, declared);
	}

	private addAssignment(
		node: Binder,
		scope: RawDescriptor[],
		kind: ScopeKind,
		moduleScope: boolean,
		parentExported: boolean,
	): void {
		const items = new Map<A.Node, A.WithItem>();
		if (node.type === "With" || node.type === "AsyncWith") {
			for (const item of node.items) if (item.optionalVars !== undefined) items.set(item.optionalVars, item);
		}
		const whole = new Set<A.Node>(wholeTargets(node));
		const declarationKind = this.isFinalAnnotation(node) ? "constant" : kind === "module" ? "variable" : "property";
		for (const target of assignmentTargets(node)) {
			if (target.id === "__all__") continue;
			this.addDeclaration(
				node,
				target,
				target.id,
				declarationKind,
				[...scope, descriptor("term", target.id)],
				kind,
				moduleScope,
				parentExported,
				whole.has(target),
				items.get(target),
			);
		}
	}

	private recordTypeParams(node: Declared, path: RawDescriptor[]): void {
		for (const parameter of node.typeParams) {
			const parameterPath = [...path, descriptor("typeParameter", parameter.name)];
			this.addDeclaration(
				parameter,
				parameter,
				parameter.name,
				"typeParameter",
				parameterPath,
				"function",
				false,
				false,
			);
		}
	}

	private recordTypeAlias(
		node: A.TypeAlias,
		scope: RawDescriptor[],
		kind: ScopeKind,
		moduleScope: boolean,
		parentExported: boolean,
	): void {
		const path = [...scope, descriptor("type", node.name.id)];
		this.declarationPaths.set(node, path);
		this.addDeclaration(node, node.name, node.name.id, "interface", path, kind, moduleScope, parentExported);
		this.recordTypeParams(node, path);
	}

	private recordDefinition(
		node: A.FunctionDef | A.ClassDef,
		scope: RawDescriptor[],
		kind: ScopeKind,
		moduleScope: boolean,
		parentExported: boolean,
	): void {
		let leaf: RawDescriptor;
		let declarationKind: RawDeclaration["kind"];
		if (node.type === "ClassDef") {
			declarationKind = "class";
			leaf = descriptor("type", node.name);
		} else {
			declarationKind = kind === "class" ? "method" : "function";
			for (const argument of parameters(node.args)) {
				if (argument.annotation !== undefined) this.addTypeAnnotation(argument, argument.annotation, scope);
			}
			leaf = this.descriptorFor(scope, descriptor("method", node.name));
		}
		const path = [...scope, leaf];
		this.declarationPaths.set(node, path);
		this.addDeclaration(node, node, node.name, declarationKind, path, kind, moduleScope, parentExported);
		this.recordTypeParams(node, path);
		if (node.type === "ClassDef") {
			const exported = this.isExported(node.name, moduleScope, parentExported);
			this.walkStatements(node.body, path, "class", false, exported);
			return;
		}
		for (const argument of writtenParameters(node.args)) {
			const argumentPath = [...path, descriptor("parameter", argument.arg)];
			this.addDeclaration(argument, argument, argument.arg, "variable", argumentPath, "function", false, false);
		}
		this.walkStatements(node.body, path, "function", false, false);
	}

	private walkStatements(
		statements: A.Statement[],
		scope: RawDescriptor[],
		kind: ScopeKind,
		moduleScope: boolean,
		parentExported: boolean,
	): void {
		for (const node of statements) {
			this.nodeScopePaths.set(node, [...scope]);
			if (isDefinition(node)) {
				this.recordDefinition(node, scope, kind, moduleScope, parentExported);
				continue;
			}
			if (node.type === "TypeAlias") {
				this.recordTypeAlias(node, scope, kind, moduleScope, parentExported);
				continue;
			}
			if (isBinder(node) && (moduleScope || kind === "class")) {
				this.addAssignment(node, scope, kind, moduleScope, parentExported);
			}
			const groups = nestedStatements(node).sort(
				(left, right) => (left[0] as A.Statement).pos - (right[0] as A.Statement).pos,
			);
			for (const nested of groups) this.walkStatements(nested, scope, kind, moduleScope, parentExported);
		}
	}

	////////////////////////////////
	//  Type descriptors

	private namedTypeDescriptor(annotation: A.Expression, scope: RawDescriptor[]): RawDescriptor[] | undefined {
		if (annotation.type !== "Name") return undefined;
		const binding = this.scopes.bindingFor({
			name: annotation.id,
			role: "typeUse",
			scopePath: scope,
			position: this.source.rangeOf(annotation).start,
		});
		return binding.status === "bound" ? binding.descriptorPath : undefined;
	}

	private refreshTypeDescriptors(): void {
		for (const raw of this.declarations.values()) {
			const node = this.declarationNodes.get(identityKey(raw.descriptorPath))?.nodes.at(-1);
			const annotation =
				node === undefined
					? undefined
					: isFunction(node)
						? node.returns
						: node.type === "AnnAssign"
							? node.annotation
							: undefined;
			if (annotation === undefined) continue;
			if (annotation.type === "Name") {
				raw.typeReference = { name: annotation.id, range: this.source.rangeOf(annotation), role: "typeUse" };
			}
			const path = this.namedTypeDescriptor(annotation, raw.descriptorPath.slice(0, -1));
			if (path !== undefined) raw.typeDescriptorPath = path;
		}
		for (const item of this.annotations) {
			if (item.node.type === "Name") {
				item.typeReference = { name: item.node.id, range: this.source.rangeOf(item.node), role: "typeUse" };
			}
			const path = this.namedTypeDescriptor(item.node, item.scopePath);
			if (path !== undefined) item.typeDescriptorPath = path;
		}
	}

	////////////////////////////////
	//  Main

	analyze(): Omit<RawFacts, "comments" | "blankLines"> {
		const allList = readAllList(this.tree, this.source);
		this.exportNames = allList.state === "static" ? new Set(allList.entries.map(({ name }) => name)) : undefined;
		this.findTypingBindings();
		this.walkStatements(this.tree.body, [], "module", true, false);
		for (const node of walk(this.tree)) {
			if (node.type !== "AnnAssign") continue;
			for (const target of namesInTarget(node.target)) {
				this.addTypeAnnotation(target, node.annotation, this.nodeScopePaths.get(node) ?? []);
			}
		}
		this.scopes = new Scopes(
			this.tree,
			(node, scope, kind) => this.declarationPath(node, scope, kind),
			this.occurrences,
			(offset) => this.source.position(offset),
			(test) => this.isTypeChecking(test),
		);
		this.refreshTypeDescriptors();
		new ReferenceVisitor(this).visit(this.tree);
		const inferredTypes = new InferenceAnalyzer(this).run();
		const literals = new LiteralVisitor(this).run();
		const exposed = moduleExports(this, allList);
		return {
			declarations: [...this.declarations.values()],
			references: this.references,
			imports: this.imports,
			exports: exposed.exports,
			allList: exposed.allList,
			importStatements: this.importStatements,
			role: fileRole(this.tree),
			prologueEnd: this.source.prologueEnd(this.tree),
			importBindings: this.importBindings,
			scopeInfos: this.scopes.raw(),
			typeAnnotations: this.annotations.map(
				({ node: _node, scopePath: _scopePath, ...annotation }) => annotation,
			),
			inferredTypes,
			literals,
			diagnostics: [],
		};
	}
}
