// Binds a file's references: a name looked up out through the scopes around it, a member through
// its receiver's type, a qualified name in the scope its qualifier names, each with what the
// includes before it reach, directly or through the headers they include.

import type { Binding, SymbolKind, UnknownReason } from "@nyaa-lexicon/protocol";
import type { CppDeclarationRecord, CppFacts, CppReferenceRecord, CppUsing, Receiver, TypeShape } from "./model.js";
import { includesBefore, type Reach, type Reaches } from "./reach.js";
import { isTransparent, memberPath, namespaceScopeId, scopeIdOf, seenScope } from "./scopes.js";
import { type Alternative, exclusive } from "./tokens.js";

////////////////////////////////
//  Interfaces & Types

/** Why a lookup found nothing. */
export interface Missing {
	reason: UnknownReason;
	detail: string;
}

/** What a lookup finds: declarations, or why none. An empty list means look further. */
type Found = { records: CppDeclarationRecord[] } | Missing;

/** A class a receiver or qualifier reaches, and the pointers and array dimensions still between. */
interface Reached {
	record: CppDeclarationRecord;
	shape: TypeShape;
}

/** The classes a base clause names, and why one of them cannot be read. */
interface DirectBases {
	classes: CppDeclarationRecord[];
	blocked?: Missing;
}

/** Where a lookup stands: a reference and its file, whose includes before it are in view. */
interface Site {
	module: string;
	reference: CppReferenceRecord;
}

/** Where a binder reads other files. */
export interface BinderSources {
	load(module: string): CppFacts | undefined;
	/** What `module`'s includes reach, `facts` being its text's. */
	reached(module: string, facts: CppFacts): Reaches;
}

////////////////////////////////
//  Constants

/** Kinds a name before `::` may bind to. */
const SCOPE_KINDS: ReadonlySet<SymbolKind> = new Set<SymbolKind>([
	"module",
	"namespace",
	"class",
	"struct",
	"enum",
	"interface",
	"typeParameter",
]);

const FUNCTION_KINDS: ReadonlySet<SymbolKind> = new Set<SymbolKind>(["function", "method", "constructor", "operator"]);

/** Declarations whose initializer or body is a complete-class context of the classes around them. */
const MEMBER_BODY_KINDS: ReadonlySet<SymbolKind> = new Set<SymbolKind>([...FUNCTION_KINDS, "field", "variable"]);

const CLASS_KEYS: ReadonlySet<string> = new Set(["class", "struct", "union"]);

const ALIAS_KINDS: ReadonlySet<string> = new Set(["typedef", "using alias"]);

/** How deep aliases of aliases are followed. */
const MAX_ALIASES = 16;

const NO_SHAPE: TypeShape = { pointers: 0, arrays: 0 };

const CIRCULAR: Missing = { reason: "NotImplemented", detail: "the name's lookup depends on itself" };

////////////////////////////////
//  Functions & Helpers

function missing(reason: UnknownReason, detail: string): Missing {
	return { reason, detail };
}

function isMissing(found: Found | Reached[]): found is Missing {
	return "reason" in found;
}

/** Stop looking: something found, or a reason nothing can be. */
function settles(found: Found): boolean {
	return isMissing(found) || found.records.length > 0;
}

/** A scope's own declarations with what its using-declarations bring in, or why those bring nothing. */
function withOwn(own: CppDeclarationRecord[], brought: Found): Found {
	if (isMissing(brought)) return own.length > 0 ? { records: own } : brought;
	return { records: [...own, ...brought.records] };
}

/**
 * What a class's direct bases find together: one declaration set however many bases reach it, all
 * of them when bases find different ones, else why a base could not be read.
 */
function combined(bases: DirectBases, settled: ReadonlyMap<CppDeclarationRecord, Found | null>): Found {
	const sets = new Map<string, CppDeclarationRecord[]>();
	let blocked = bases.blocked;
	for (const base of bases.classes) {
		const found = settled.get(base);
		if (found === undefined || found === null) continue;
		if (isMissing(found)) blocked ??= found;
		else if (found.records.length > 0) {
			const ids = [...new Set(found.records.map((record) => record.declaration.symbolId))].sort().join("\u0000");
			if (!sets.has(ids)) sets.set(ids, found.records);
		}
	}
	if (sets.size > 0) return { records: [...new Set([...sets.values()].flat())] };
	return blocked ?? { records: [] };
}

/** A class, struct or union by its key, not an alias of one. */
function isClassKey(record: CppDeclarationRecord): boolean {
	return CLASS_KEYS.has(record.declaration.languageKind ?? "");
}

function isAlias(record: CppDeclarationRecord): boolean {
	return ALIAS_KINDS.has(record.declaration.languageKind ?? "");
}

/** A scope holding members: a class with its body, an enum, or an alias of an unnamed class. */
function holdsMembers(record: CppDeclarationRecord): boolean {
	return record.bodyStart !== undefined || record.declaration.kind === "enum";
}

function kindAllowed(record: CppDeclarationRecord, reference: CppReferenceRecord): boolean {
	return !reference.scope || SCOPE_KINDS.has(record.declaration.kind);
}

/** The names a record's written qualifier adds between its parent and itself, `A` in `void A::f()`. */
function writtenQualifier(record: CppDeclarationRecord): string[] {
	return record.names.slice(record.parent?.names.length ?? 0, -1);
}

function joinPath(scope: string, names: readonly string[]): string {
	return [...(scope === "" ? [] : [scope]), ...names].join("::");
}

/**
 * Of the records a scope in the reference's own file offers, those it sees: declared before it
 * unless `complete`, in no other `#if` branch, and of locals only the innermost, which hide the rest.
 */
function visibleOf(
	records: readonly CppDeclarationRecord[],
	reference: CppReferenceRecord,
	complete: boolean,
): CppDeclarationRecord[] {
	const at = reference.tokenIndex;
	const kept = records.filter(
		(record) =>
			record.nameTokenStart !== at &&
			kindAllowed(record, reference) &&
			!exclusive(record.alternative, reference.alternative) &&
			(record.visibleEnd !== undefined || complete || record.declaredAt < at),
	);
	const locals = kept.filter((record) => record.visibleEnd !== undefined);
	if (locals.length === 0) return kept;
	return innermost(locals);
}

/**
 * Of locals named alike, those no later one hides: a later local hides an earlier one unless the
 * two stand in different branches of one `#if` group. Each local is weighed against all later ones
 * at once, by counting the later ones inside each group and each branch around it.
 */
function innermost(locals: readonly CppDeclarationRecord[]): CppDeclarationRecord[] {
	const inside = new Map<string, number>();
	const around = (local: CppDeclarationRecord) => {
		const keys: Array<[string, string]> = [];
		for (let alternative = local.alternative; alternative !== undefined; alternative = alternative.outer)
			keys.push([`${alternative.group}`, `${alternative.group}:${alternative.branch}`]);
		return keys;
	};
	const hidden = new Set<CppDeclarationRecord>();
	const latestFirst = [...locals].sort((left, right) => right.nameTokenStart - left.nameTokenStart);
	let later = 0;
	for (let start = 0; start < latestFirst.length; ) {
		// Locals at one position hide none of each other.
		let end = start + 1;
		const at = (latestFirst[start] as CppDeclarationRecord).nameTokenStart;
		while (end < latestFirst.length && (latestFirst[end] as CppDeclarationRecord).nameTokenStart === at) end++;
		const tied = latestFirst.slice(start, end);
		for (const local of tied) {
			let apart = 0;
			for (const [group, branch] of around(local)) apart += (inside.get(group) ?? 0) - (inside.get(branch) ?? 0);
			if (later > apart) hidden.add(local);
		}
		for (const local of tied) for (const key of around(local).flat()) inside.set(key, (inside.get(key) ?? 0) + 1);
		later += tied.length;
		start = end;
	}
	return locals.filter((local) => !hidden.has(local));
}

/**
 * Of a class template and its specializations, the one a reference names: the explicit
 * specialization its written arguments spell, else the primary template.
 */
function specializationOf(
	records: readonly CppDeclarationRecord[],
	reference: CppReferenceRecord,
): CppDeclarationRecord[] {
	const specialized = records.filter((record) => record.own.name !== record.declaration.name);
	if (specialized.length === 0 || specialized.length === records.length) return [...records];
	const exact = specialized.filter((record) => record.own.name === reference.written);
	return exact.length > 0 ? exact : records.filter((record) => record.own.name === record.declaration.name);
}

/** A namespace however many files open it: this file's opening, else the first include's. */
function oneNamespace(records: CppDeclarationRecord[], module: string): CppDeclarationRecord[] {
	if (!records.every((record) => record.declaration.kind === "namespace")) return records;
	return [records.find((record) => record.module === module) ?? (records[0] as CppDeclarationRecord)];
}

/** Whether a local's window, or a non-local's declaration, covers token `at`. */
function inView(record: CppDeclarationRecord, at: number, alternative: Alternative | undefined): boolean {
	if (exclusive(record.alternative, alternative)) return false;
	if (record.visibleEnd === undefined) return record.declaredAt < at;
	return (record.visibleFrom ?? record.nameTokenStart) <= at && at < record.visibleEnd;
}

/** Whether a using stands before the reference, in its block, and in no other `#if` branch. */
function applies(using: CppUsing, reference: CppReferenceRecord): boolean {
	const at = reference.tokenIndex;
	return (
		using.at < at &&
		(using.end === undefined || at < using.end) &&
		!exclusive(using.alternative, reference.alternative)
	);
}

////////////////////////////////
//  Classes

/** Binds references across the files one request reaches, each lookup once. */
export class CppBinder {
	private readonly files = new Map<string, CppFacts | undefined>();

	/** Each settled lookup by module and token; null while one is under way. */
	private readonly found = new Map<string, Found | null>();

	/** What each file's includes reach, by module. */
	private readonly reaches = new Map<string, Reaches>();

	/** What each file's includes reach, by module and count of includes passed. */
	private readonly reachesBefore = new Map<string, Reach>();

	private readonly paths = new Map<CppDeclarationRecord, string>();

	constructor(
		private readonly sources: BinderSources,
		module: string,
		facts: CppFacts,
	) {
		this.files.set(module, facts);
	}

	bind(module: string, reference: CppReferenceRecord): Binding {
		const found = this.lookup(module, reference);
		if (isMissing(found)) return { status: "unbound", reason: found.reason, detail: found.detail };
		const ids = [...new Set(found.records.map((record) => record.declaration.symbolId))];
		if (ids.length === 1) return { status: "bound", symbolId: ids[0] as string, provenance: "bound" };
		return { status: "ambiguous", candidates: ids, provenance: "bound" };
	}

	/** The scope id of the one named namespace the name at `token` writes, through aliases; why none. */
	namespaceAt(module: string, token: number): { scopeId: string } | Missing {
		const reference = this.facts(module)?.referencesByToken.get(token);
		if (reference === undefined) return missing("NotImplemented", "no name writes the namespace");
		const found = this.lookup(module, reference);
		if (isMissing(found)) return found;
		const ids = new Set(
			found.records
				.filter((record) => record.declaration.kind === "namespace")
				.flatMap((namespace) => this.aliased(namespace))
				.map(namespaceScopeId),
		);
		const [id] = ids;
		if (id === undefined) return missing("NotImplemented", "the name is no namespace");
		if (ids.size > 1) return missing("Ambiguous", "the name opens different namespaces");
		if (id === null) return missing("NotImplemented", "an unnamed namespace is its file's own");
		return { scopeId: id };
	}

	private facts(module: string): CppFacts | undefined {
		if (!this.files.has(module)) this.files.set(module, this.sources.load(module));
		return this.files.get(module);
	}

	/** What a reference binds to: never an empty list. */
	private lookup(module: string, reference: CppReferenceRecord): Found {
		const key = `${module}\u0000${reference.tokenIndex}`;
		const known = this.found.get(key);
		if (known !== undefined) return known ?? CIRCULAR;
		this.found.set(key, null);
		const facts = this.facts(module);
		const found =
			facts === undefined
				? missing("NotIndexed", "module is not indexed")
				: this.resolve(module, facts, reference);
		const settled = isMissing(found)
			? found
			: found.records.length > 0
				? { records: oneNamespace(specializationOf(found.records, reference), module) }
				: this.missingName(module, reference);
		this.found.set(key, settled);
		return settled;
	}

	private resolve(module: string, facts: CppFacts, reference: CppReferenceRecord): Found {
		if (reference.prototypeOf !== undefined) return { records: [reference.prototypeOf] };
		if (reference.macro) return missing("NotImplemented", "a macro's names resolve where it expands");
		if (reference.receiver !== undefined) return this.member(module, facts, reference, reference.receiver);
		if (reference.qualifierToken !== undefined) return this.qualified(module, facts, reference);
		if (reference.global) return this.inNamespaceAt(module, facts, reference, null);
		if (reference.qualified) return missing("NotImplemented", "the name's scope is an expression's");
		return this.unqualified(module, facts, reference);
	}

	/** Why a name found nowhere is unbound: a template's argument, an external header, or no file. */
	private missingName(module: string, reference: CppReferenceRecord): Missing {
		if (reference.inTemplate) return missing("NotImplemented", "a template's name may come with its arguments");
		const reach = this.reachBefore(module, reference.tokenIndex);
		if (reach.external) return missing("ExternalDependency", "the name comes from an external header");
		if (reach.unresolved) return missing("NotIndexed", "the included header is unresolved");
		return missing("NotIndexed", "no indexed declaration matches the name");
	}

	////////////////////////////////
	//  Unqualified names

	/**
	 * An unqualified name, looked up out through the scopes around it; the first scope with a match
	 * decides. A body offers its locals and parameters, a class its members then its bases', a
	 * written qualifier's scope its members, and a namespace its own declarations with what its
	 * using-directives nominate, then the includes' before them. A block's using-directive nominates
	 * into the nearest namespace holding both it and the namespace it names.
	 */
	private unqualified(module: string, facts: CppFacts, reference: CppReferenceRecord): Found {
		let complete = false;
		const carried: CppUsing[] = [];
		let scope = reference.from;
		while (scope !== null) {
			const namespace = scope.declaration.kind === "namespace";
			const found = namespace
				? this.inNamespaceAt(module, facts, reference, scope, carried)
				: this.inScope(module, facts, reference, scope, complete);
			if (settles(found)) return found;
			if (!namespace)
				for (const using of facts.usingsByScope.get(scopeIdOf(scope)) ?? [])
					if (!using.declaration && applies(using, reference)) carried.push(using);
			const qualifier = writtenQualifier(scope);
			for (let length = qualifier.length; length > 0; length--) {
				const path = joinPath(this.pathOf(scope.parent), qualifier.slice(0, length));
				const outside = this.atPath(module, reference, path);
				if (settles(outside)) return outside;
			}
			// A member's body, default argument or initializer sees the whole class around it.
			if (MEMBER_BODY_KINDS.has(scope.declaration.kind) && reference.tokenIndex > scope.nameTokenStart)
				complete = true;
			scope = scope.parent;
		}
		return this.inNamespaceAt(module, facts, reference, null, carried);
	}

	/** A body's or a class's own names and using-declarations, then a class's bases'. */
	private inScope(
		module: string,
		facts: CppFacts,
		reference: CppReferenceRecord,
		scope: CppDeclarationRecord,
		complete: boolean,
	): Found {
		// A class's own name in it is the class, not its constructors.
		if (isClassKey(scope) && scope.declaration.name === reference.name && kindAllowed(scope, reference))
			return { records: [scope] };
		const own = this.ownMembers(module, reference, scope, complete);
		const brought = this.usingDeclarations(module, facts, reference, scopeIdOf(scope));
		if (own.length > 0 || settles(brought)) return withOwn(own, brought);
		// A base clause is looked up around its class, never in the bases it names.
		if (scope.bodyStart === undefined || reference.tokenIndex < scope.bodyStart) return { records: [] };
		return this.inBases(module, scope, reference);
	}

	/**
	 * A scope's own declarations named like the reference, its transparent scopes' included. Another
	 * file's scope, included before the reference, is seen whole.
	 */
	private ownMembers(
		module: string,
		reference: CppReferenceRecord,
		scope: CppDeclarationRecord,
		complete: boolean,
	): CppDeclarationRecord[] {
		const facts = this.facts(scope.module);
		if (facts === undefined) return [];
		const at = reference.tokenIndex;
		const id = scopeIdOf(scope);
		const here = scope.module === module;
		const bucket = facts.members.get(id)?.get(reference.name);
		const found = here
			? visibleOf(bucket?.visibleAt(at) ?? [], reference, complete)
			: (bucket?.visibleAt(-1) ?? []).filter((record) => kindAllowed(record, reference));
		for (const inner of facts.transparentOf.get(id) ?? [])
			if (!here || complete || inView(inner, at, reference.alternative))
				found.push(...this.ownMembers(module, reference, inner, complete));
		return found;
	}

	/**
	 * A namespace's declarations named like the reference, the file's for a null scope: this file's
	 * declared before it, its using-declarations', and what its using-directives and the `carried`
	 * ones of blocks inside it nominate; else the includes' before it.
	 */
	private inNamespaceAt(
		module: string,
		facts: CppFacts,
		reference: CppReferenceRecord,
		scope: CppDeclarationRecord | null,
		carried: readonly CppUsing[] = [],
	): Found {
		const path = this.pathOf(scope);
		const own = visibleOf(facts.membersByPath.get(path)?.get(reference.name) ?? [], reference, false);
		const directives = (facts.usingsByScope.get(scopeIdOf(scope)) ?? []).filter(
			(using) => !using.declaration && applies(using, reference),
		);
		for (const using of [...directives, ...carried])
			for (const namespace of this.namespacesAt(module, facts, using.nameToken)) {
				const inner = this.pathOf(namespace);
				const holds = path === "" || inner === path || inner.startsWith(`${path}::`);
				if (directives.includes(using) || holds)
					own.push(...this.inNamespace(module, facts, reference, namespace));
			}
		const brought = this.usingDeclarations(module, facts, reference, scopeIdOf(scope));
		if (own.length > 0 || settles(brought)) return withOwn(own, brought);
		return { records: this.included(module, reference, path) };
	}

	/** The declarations named like the reference in a namespace a using-directive or qualifier names. */
	private inNamespace(
		module: string,
		facts: CppFacts,
		reference: CppReferenceRecord,
		namespace: CppDeclarationRecord,
	): CppDeclarationRecord[] {
		// An inline or anonymous namespace named outright holds only its own members.
		if (isTransparent(namespace)) return this.ownMembers(module, reference, namespace, false);
		const path = this.pathOf(namespace);
		const own = visibleOf(facts.membersByPath.get(path)?.get(reference.name) ?? [], reference, false);
		return own.length > 0 ? own : this.included(module, reference, path);
	}

	/**
	 * The declarations the includes before a reference reach at `path`, named like it: the nearest
	 * include depth declaring any, so a header included directly outranks one further in.
	 */
	private included(module: string, reference: CppReferenceRecord, path: string): CppDeclarationRecord[] {
		const reach = this.reachBefore(module, reference.tokenIndex);
		for (const { records } of reach.declared(path, reference.name)) {
			const found = records.filter((record) => kindAllowed(record, reference));
			if (found.length > 0) return found;
		}
		return [];
	}

	/**
	 * A written qualifier's scope no record in this file holds, `A` in `void A::f()`: its members in
	 * this file, else in the includes before the reference, else its bases'.
	 */
	private atPath(module: string, reference: CppReferenceRecord, path: string): Found {
		const own = visibleOf(this.facts(module)?.membersByPath.get(path)?.get(reference.name) ?? [], reference, true);
		if (own.length > 0) return { records: own };
		const included = this.included(module, reference, path);
		if (included.length > 0) return { records: included };
		const separator = path.lastIndexOf("::");
		const outer = separator < 0 ? "" : path.slice(0, separator);
		const name = separator < 0 ? path : path.slice(separator + 2);
		for (const scope of this.classesAt(module, reference, outer, name)) {
			const inherited = this.inBases(module, scope, reference);
			if (settles(inherited)) return inherited;
		}
		return { records: [] };
	}

	/**
	 * Classes with bodies named `name` at `path`: this file's, else those at the nearest include
	 * depth before `reference` that has any.
	 */
	private classesAt(
		module: string,
		reference: CppReferenceRecord,
		path: string,
		name: string,
	): CppDeclarationRecord[] {
		const hasBody = (record: CppDeclarationRecord) => record.bodyStart !== undefined;
		const own = (this.facts(module)?.membersByPath.get(path)?.get(name) ?? []).filter(hasBody);
		if (own.length > 0) return own;
		const reach = this.reachBefore(module, reference.tokenIndex);
		for (const { records } of reach.declared(path, name)) {
			const found = records.filter(hasBody);
			if (found.length > 0) return found;
		}
		return [];
	}

	/** What the using-declarations standing in a scope before the reference bring in under its name. */
	private usingDeclarations(module: string, facts: CppFacts, reference: CppReferenceRecord, scopeId: string): Found {
		const brought: CppDeclarationRecord[] = [];
		let unresolved: Missing | undefined;
		for (const using of facts.usingsByScope.get(scopeId) ?? []) {
			if (!using.declaration || !applies(using, reference)) continue;
			const written = facts.referencesByToken.get(using.nameToken);
			if (written?.name !== reference.name) continue;
			const targets = this.lookup(module, written);
			if (isMissing(targets)) unresolved = missing(targets.reason, "a using-declaration brings in the name");
			else brought.push(...targets.records.filter((record) => kindAllowed(record, reference)));
		}
		return brought.length === 0 && unresolved !== undefined ? unresolved : { records: brought };
	}

	/** What the reference at `token` binds to, of `kind` when given; none when it is unbound. */
	private targetsOf(module: string, facts: CppFacts, token: number, kind?: SymbolKind): CppDeclarationRecord[] {
		const reference = facts.referencesByToken.get(token);
		const found = reference === undefined ? undefined : this.lookup(module, reference);
		if (found === undefined || isMissing(found)) return [];
		return kind === undefined ? found.records : found.records.filter((record) => record.declaration.kind === kind);
	}

	/** The namespaces the name at `token` names, a namespace alias's target in its place. */
	private namespacesAt(module: string, facts: CppFacts, token: number): CppDeclarationRecord[] {
		return this.targetsOf(module, facts, token, "namespace").flatMap((namespace) => this.aliased(namespace));
	}

	/** A namespace, or the namespaces an alias of one names, through aliases of aliases. */
	private aliased(namespace: CppDeclarationRecord, depth = 0): CppDeclarationRecord[] {
		if (namespace.aliasOf === undefined) return [namespace];
		const facts = this.facts(namespace.module);
		if (facts === undefined || depth > MAX_ALIASES) return [];
		return this.targetsOf(namespace.module, facts, namespace.aliasOf, "namespace").flatMap((target) =>
			this.aliased(target, depth + 1),
		);
	}

	////////////////////////////////
	//  Classes and their bases

	/**
	 * Members named like the reference in the classes `scope` derives from, as class member lookup
	 * finds them: a base's own members, else what its bases find, sibling bases' findings combined.
	 * Two bases finding different declarations make the name ambiguous; one declaration reached
	 * through two bases does not. A base this provider cannot read stops the lookup when no base
	 * finds the name. Each class is visited once, without recursion, however deep its bases go.
	 */
	private inBases(module: string, scope: CppDeclarationRecord, reference: CppReferenceRecord): Found {
		// What each class finds; null while its bases are still being looked in.
		const settled = new Map<CppDeclarationRecord, Found | null>();
		const direct = new Map<CppDeclarationRecord, DirectBases>();
		const pending = [scope];
		for (let top = pending.at(-1); top !== undefined; top = pending.at(-1)) {
			const state = settled.get(top);
			if (state === null) {
				pending.pop();
				settled.set(top, combined(direct.get(top) as DirectBases, settled));
				continue;
			}
			if (state !== undefined) {
				pending.pop();
				continue;
			}
			// A base's own name in the derived class is the base.
			const own =
				top === scope
					? []
					: isClassKey(top) && top.declaration.name === reference.name
						? [top]
						: this.classMembers(module, top, reference);
			if (own.length > 0) {
				settled.set(top, { records: own });
				pending.pop();
				continue;
			}
			settled.set(top, null);
			const bases = this.directBases(module, top, reference);
			direct.set(top, bases);
			// A base already open around this one is a cycle, and finds nothing more.
			for (const base of bases.classes) if (!settled.has(base)) pending.push(base);
		}
		return settled.get(scope) ?? { records: [] };
	}

	/**
	 * The classes a base clause names, and why one cannot be read. A base waiting on template
	 * arguments is none.
	 */
	private directBases(module: string, scope: CppDeclarationRecord, reference: CppReferenceRecord): DirectBases {
		const facts = this.facts(scope.module);
		const tokens = scope.baseTokens ?? [];
		const classes: CppDeclarationRecord[] = [];
		let blocked: Missing | undefined;
		for (const [at, token] of tokens.entries()) {
			const written = facts?.referencesByToken.get(token);
			if (written === undefined || (scope.templateDependent && written.templated)) continue;
			const bases = this.classesOf(scope.module, token, NO_SHAPE, { module, reference });
			if (isMissing(bases)) {
				if (bases.reason === "NotImplemented" && scope.templateDependent) continue;
				// A base waiting on template arguments is one, even under a head a macro hides.
				const end = tokens[at + 1] ?? scope.bodyStart ?? token;
				if (written.templated && this.dependsWithin(scope.module, token + 1, end)) continue;
				blocked ??= missing(bases.reason, "the name may be a member of a base this provider cannot read");
				continue;
			}
			for (const { record } of bases) if (!classes.includes(record)) classes.push(record);
		}
		return blocked === undefined ? { classes } : { classes, blocked };
	}

	/** Whether a name among the tokens `[from, to)` of a file is a template parameter, or binds to nothing. */
	private dependsWithin(module: string, from: number, to: number): boolean {
		const facts = this.facts(module);
		for (let index = from; index < to; index++) {
			const reference = facts?.referencesByToken.get(index);
			const found = reference === undefined ? undefined : this.lookup(module, reference);
			if (found === undefined) continue;
			if (isMissing(found) || found.records.some((record) => record.declaration.kind === "typeParameter"))
				return true;
		}
		return false;
	}

	/** A class's members named like the reference, then its bases'. */
	private inClass(module: string, scope: CppDeclarationRecord, reference: CppReferenceRecord): Found {
		const own = this.classMembers(module, scope, reference);
		return own.length > 0 ? { records: own } : this.inBases(module, scope, reference);
	}

	/**
	 * A class's own members named like the reference. For another file's class, the definitions of
	 * its members this file writes come first, as its own declarations do elsewhere.
	 */
	private classMembers(
		module: string,
		scope: CppDeclarationRecord,
		reference: CppReferenceRecord,
	): CppDeclarationRecord[] {
		if (scope.module !== module) {
			const defined = this.facts(module)?.membersByPath.get(this.pathOf(scope))?.get(reference.name) ?? [];
			const written = visibleOf(defined, reference, true);
			if (written.length > 0) return written;
		}
		return this.ownMembers(module, reference, scope, true);
	}

	/**
	 * The classes the type named at `token` is, aliases followed, each with the pointers and arrays
	 * still between; `shape` is what already stands around the type. A class only declared there is
	 * the definition in view of `site`.
	 */
	private classesOf(module: string, token: number, shape: TypeShape, site: Site, depth = 0): Reached[] | Missing {
		if (depth > MAX_ALIASES) return missing("NotImplemented", "the type's aliases nest too deeply");
		const facts = this.facts(module);
		const reference = facts?.referencesByToken.get(token);
		const declared = facts?.declarationsByToken.get(token);
		const found: Found =
			reference !== undefined
				? this.lookup(module, reference)
				: declared !== undefined
					? { records: [declared] }
					: missing("NotImplemented", "the type is no name this provider reads");
		if (isMissing(found)) return found;
		const reached: Reached[] = [];
		for (const record of found.records) {
			if (record.declaration.kind === "typeParameter")
				return missing("NotImplemented", "the type waits on a template argument");
			if (isAlias(record) && record.typeRef !== undefined) {
				const inner = record.typeShape ?? NO_SHAPE;
				const around = { pointers: shape.pointers + inner.pointers, arrays: shape.arrays + inner.arrays };
				const aliased = this.classesOf(record.module, record.typeRef, around, site, depth + 1);
				if (isMissing(aliased)) return aliased;
				reached.push(...aliased);
			} else if (holdsMembers(record)) reached.push({ record, shape });
			else if (isClassKey(record)) {
				const path = seenScope(record).join("::");
				const defined = this.classesAt(site.module, site.reference, path, record.declaration.name);
				reached.push(...defined.map((definition) => ({ record: definition, shape })));
			}
		}
		return reached.length > 0 ? reached : missing("NotImplemented", "the type is not a class this provider reads");
	}

	////////////////////////////////
	//  Qualified names and members

	/** A name after `::`, looked up in the scopes its qualifier binds to. */
	private qualified(module: string, facts: CppFacts, reference: CppReferenceRecord): Found {
		const written = facts.referencesByToken.get(reference.qualifierToken ?? -1);
		if (written === undefined) return missing("NotImplemented", "the qualifier is no name this provider reads");
		const scopes = this.lookup(module, written);
		if (isMissing(scopes)) return missing(scopes.reason, "the name's qualifier is unresolved");
		const found: CppDeclarationRecord[] = [];
		for (const scope of scopes.records) {
			if (scope.declaration.kind === "typeParameter")
				return missing("NotImplemented", "the qualifier waits on a template argument");
			if (scope.declaration.kind === "namespace") {
				for (const namespace of this.aliased(scope))
					found.push(...this.inNamespace(module, facts, reference, namespace));
				continue;
			}
			const classes = isAlias(scope)
				? this.classesOf(scope.module, scope.nameTokenStart, NO_SHAPE, { module, reference })
				: holdsMembers(scope)
					? [{ record: scope, shape: NO_SHAPE }]
					: [];
			if (isMissing(classes)) return missing(classes.reason, "the name's qualifier is unresolved");
			for (const { record } of classes) {
				const members = this.inClass(module, record, reference);
				if (isMissing(members)) return members;
				found.push(...members.records);
			}
		}
		return { records: found };
	}

	/** A member after `.` or `->`, looked up in the class its receiver's type names. */
	private member(module: string, facts: CppFacts, reference: CppReferenceRecord, receiver: Receiver): Found {
		const classes = this.receiverClasses(module, facts, reference, receiver);
		if (isMissing(classes)) return classes;
		const found: CppDeclarationRecord[] = [];
		for (const { record, shape } of classes) {
			// `->` reaches through one pointer, `.` through none; an overloaded `->` is not followed.
			if (shape.pointers + shape.arrays !== (receiver.arrow ? 1 : 0))
				return missing("NotImplemented", "the receiver's type is not reached by its operator");
			const members = this.inClass(module, record, reference);
			if (isMissing(members)) return members;
			found.push(...members.records);
		}
		if (found.length > 0) return { records: found };
		return reference.inTemplate
			? missing("NotImplemented", "a template's member may come with its arguments")
			: missing("NotIndexed", "the receiver's class declares no such member");
	}

	/** The classes a receiver's type names, with the pointers and arrays still to reach through. */
	private receiverClasses(
		module: string,
		facts: CppFacts,
		reference: CppReferenceRecord,
		receiver: Receiver,
	): Reached[] | Missing {
		if (receiver.kind === "this") {
			const scope = this.enclosingClass(module, reference);
			return scope === undefined
				? missing("NotImplemented", "no class holds this `this`")
				: [{ record: scope, shape: { pointers: 1, arrays: 0 } }];
		}
		const written = facts.referencesByToken.get(receiver.token);
		if (written === undefined) return missing("NotImplemented", "the receiver is no name this provider reads");
		const found = this.lookup(module, written);
		if (isMissing(found)) return missing(found.reason, "the receiver is unresolved");
		const [record, ...rest] = found.records;
		if (record === undefined || rest.length > 0) return missing("NotImplemented", "the receiver is ambiguous");
		// `T()` and `T{}` make a `T`.
		if (receiver.kind === "call" && (isClassKey(record) || isAlias(record)))
			return this.classesOf(record.module, record.nameTokenStart, NO_SHAPE, { module, reference });
		if (record.declaration.kind === "typeParameter" || record.typeRef === undefined)
			return missing("NotImplemented", "the receiver's type is not declared");
		if ((receiver.kind === "call") !== FUNCTION_KINDS.has(record.declaration.kind))
			return missing("NotImplemented", "the receiver's call is not followed");
		const classes = this.classesOf(record.module, record.typeRef, record.typeShape ?? NO_SHAPE, {
			module,
			reference,
		});
		if (isMissing(classes) || receiver.kind !== "subscript") return classes;
		// A subscript's element is one array dimension in, or one pointer.
		return classes.map(({ record: element, shape }) => ({
			record: element,
			shape:
				shape.arrays > 0 ? { ...shape, arrays: shape.arrays - 1 } : { pointers: shape.pointers - 1, arrays: 0 },
		}));
	}

	/** The class `this` points to: the nearest one around the reference, or a member's written qualifier's. */
	private enclosingClass(module: string, reference: CppReferenceRecord): CppDeclarationRecord | undefined {
		for (let scope = reference.from; scope !== null; scope = scope.parent) {
			if (scope.bodyStart !== undefined) return scope;
			const qualifier = writtenQualifier(scope);
			if (qualifier.length === 0) continue;
			const outer = joinPath(this.pathOf(scope.parent), qualifier.slice(0, -1));
			const [found, ...rest] = this.classesAt(module, reference, outer, qualifier.at(-1) as string);
			return rest.length === 0 ? found : undefined;
		}
		return undefined;
	}

	////////////////////////////////
	//  Files

	/** The qualified name code outside uses for a scope's members, once per record. */
	private pathOf(scope: CppDeclarationRecord | null): string {
		if (scope === null) return "";
		const known = this.paths.get(scope);
		if (known !== undefined) return known;
		const path = memberPath(scope);
		this.paths.set(scope, path);
		return path;
	}

	/** What the includes standing before token `at` reach, once per file and count of includes. */
	private reachBefore(module: string, at: number): Reach {
		const facts = this.facts(module);
		if (facts === undefined) return { declared: () => [], external: false, unresolved: true };
		const count = includesBefore(facts, at);
		const key = `${module}\u0000${count}`;
		const known = this.reachesBefore.get(key);
		if (known !== undefined) return known;
		let reaches = this.reaches.get(module);
		if (reaches === undefined) {
			reaches = this.sources.reached(module, facts);
			this.reaches.set(module, reaches);
		}
		const reach = reaches.before(count);
		this.reachesBefore.set(key, reach);
		return reach;
	}
}
