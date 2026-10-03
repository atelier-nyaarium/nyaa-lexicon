// Using directives as the protocol's transfers: one import edge per directive, where its specifier
// lands, and the scopes each declared namespace and type contribute members to.

import type {
	Certainty,
	Conflict,
	Import,
	ImportEdge,
	ImportResolution,
	Landing,
	ScopeContribution,
} from "@nyaa-lexicon/protocol";
import { CsharpImports, isExternAlias, isExternalSpecifier, type Using } from "./imports.js";
import { type CsharpImport, type DeclarationMeta, PROVIDER_ID } from "./model.js";
import { type IndexedType, inFileType, isTypeKind, joinNamespace, typeKey } from "./namespaces.js";
import { positionRange } from "./tokens.js";
import type { IndexedFacts } from "./workspace.js";

////////////////////////////////
//  Interfaces & Types

/** What a directive's target names in the workspace, and where each reading lands. */
type Reach = { kind: "namespace"; landing: Landing } | { kind: "types"; landings: Landing[] } | { kind: "none" };

////////////////////////////////
//  Constants

const KNOWN: Certainty = { status: "known" };

const NONE: Reach = { kind: "none" };

const INJECTED: Conflict = { priority: 0, amongTransfers: "exclude", againstLocal: "localWins" };

// An alias outranks the types a using namespace brings.
const ALIASED: Conflict = { priority: 1, amongTransfers: "exclude", againstLocal: "localWins" };

////////////////////////////////
//  Functions & Helpers

function packageScope(namespace: string): Landing {
	return { kind: "packageScope", providerId: PROVIDER_ID, scopeId: namespace };
}

function landingKey(landing: Landing): string {
	return landing.kind === "module" ? `module\0${landing.module}` : `${landing.kind}\0${landing.scopeId}`;
}

/** A directive bringing a namespace's types: neither an alias nor `using static`. */
function isPlain(directive: CsharpImport): boolean {
	return !directive.static && directive.alias === undefined;
}

/** A type a scope can hold or open; an extension block is neither. */
function isScopeType(meta: DeclarationMeta): boolean {
	return isTypeKind(meta.declaration) && meta.declaration.languageKind !== "extension";
}

/** What `using static` brings of a type's members: nested types and static members, never a constructor. */
function isStaticallyBrought(meta: DeclarationMeta): boolean {
	const { declaration } = meta;
	if (declaration.visibility === "private" || declaration.visibility === "local") return false;
	if (isTypeKind(declaration)) return isScopeType(meta);
	return declaration.kind !== "constructor" && (declaration.kind === "constant" || meta.isStatic === true);
}

////////////////////////////////
//  Classes

export abstract class CsharpTransfers extends CsharpImports {
	/**
	 * A namespace lands on its package scope, `using static T` on T's scope, any other type on the scope
	 * holding it. Directives of one specifier that land apart, as in two namespace bodies, are ambiguous.
	 */
	resolveImport(params: { fromModule: string; specifier: string }): ImportResolution {
		const { fromModule, specifier } = params;
		const facts = this.factsForModule(fromModule);
		const written = facts?.imports.filter((item) => item.specifier === specifier) ?? [];
		// One landing per specifier: a `using static` wins over an alias of the same type.
		const statics = written.filter((item) => item.static);
		const directives = statics.length > 0 ? statics : written;
		const answers = (directives.length === 0 ? [undefined] : directives).map((directive) =>
			this.resolveDirective(fromModule, facts, specifier, directive),
		);
		const [first] = answers;
		const key = JSON.stringify(first);
		if (first !== undefined && answers.every((answer) => JSON.stringify(answer) === key)) return first;
		return {
			status: "unresolved",
			reason: "Ambiguous",
			detail: `${specifier} lands apart in ${answers.length} directives`,
		};
	}

	/** Each directive as one import of one edge, in source order. */
	protected importFacts(facts: IndexedFacts): Import[] {
		return facts.imports.map((directive, order) => ({
			specifier: directive.specifier,
			edges: [this.importEdge(facts, directive, order)],
		}));
	}

	/**
	 * Each namespace this file declares, with its types another file can reach, every part of a partial
	 * one included; and each type's scope, with what `using static` brings of its members here.
	 */
	protected scopeContributions(facts: IndexedFacts): ScopeContribution[] {
		const packages = new Map<string, string[]>(facts.namespaceNames.map((name) => [name, []]));
		const types = new Map<string, string[]>();
		for (const meta of facts.metadata.values()) {
			if (!isScopeType(meta) || meta.declaration.visibility === "local" || inFileType(meta, facts.metadata))
				continue;
			const scopeId = joinNamespace(meta.namespaceName, typeKey(meta));
			if (!types.has(scopeId)) types.set(scopeId, []);
			if (meta.typePath === "") packages.get(meta.namespaceName)?.push(meta.declaration.symbolId);
		}
		for (const meta of facts.metadata.values()) {
			const parent = meta.parentId === undefined ? undefined : facts.metadata.get(meta.parentId);
			if (parent === undefined || !isScopeType(parent) || !isStaticallyBrought(meta)) continue;
			types.get(joinNamespace(parent.namespaceName, typeKey(parent)))?.push(meta.declaration.symbolId);
		}
		return [
			...[...packages].map(([scopeId, members]) => ({ kind: "packageScope" as const, scopeId, members })),
			...[...types].map(([scopeId, members]) => ({ kind: "symbolScope" as const, scopeId, members })),
		];
	}

	/** Where one directive, or a specifier no directive writes, lands. */
	private resolveDirective(
		fromModule: string,
		facts: IndexedFacts | null,
		specifier: string,
		directive: CsharpImport | undefined,
	): ImportResolution {
		if (directive?.qualifier !== undefined && isExternAlias(directive.qualifier))
			return { status: "external", packageName: directive.qualifier };
		const using: Using = directive ?? {
			specifier,
			static: false,
			target: specifier.split(".").map((name) => ({ name, arity: 0 })),
		};
		const base = facts === null ? "" : this.baseOf(facts, directive?.scopeId);
		const reach = this.reach(fromModule, using, base, directive !== undefined && isPlain(directive));
		if (reach.kind === "namespace") return { status: "resolved", landing: reach.landing };
		const [landing, ...others] = reach.kind === "types" ? reach.landings : [];
		if (landing !== undefined && others.length === 0) return { status: "resolved", landing };
		if (landing !== undefined)
			return {
				status: "unresolved",
				reason: "Ambiguous",
				detail: `${specifier} names types in ${others.length + 1} scopes`,
			};
		if (isExternalSpecifier(specifier)) return { status: "external", packageName: specifier };
		return {
			status: "unresolved",
			reason: "NotIndexed",
			detail: `no workspace namespace or type matches ${specifier}`,
		};
	}

	private importEdge(facts: IndexedFacts, directive: CsharpImport, order: number): ImportEdge {
		const common = {
			span: directive.span,
			bindsLocally: true,
			visibility: directive.global ? ("internal" as const) : ("fileLocal" as const),
			order,
		};
		if (directive.static || directive.alias === undefined || directive.aliasRange === undefined) {
			return {
				kind: "injection",
				...common,
				selector: { kind: "visible" },
				conflict: INJECTED,
				certainty: KNOWN,
			};
		}
		const local = { local: directive.alias, localRange: directive.aliasRange };
		const reach = this.reach(facts.module, directive, this.baseOf(facts, directive.scopeId), false);
		if (reach.kind === "namespace")
			return { kind: "namespace", ...common, ...local, conflict: ALIASED, certainty: KNOWN };
		// Type arguments prove a type; otherwise an unresolved target may be a namespace.
		const certainty: Certainty =
			reach.kind === "types" || directive.target.some((segment) => segment.arity > 0)
				? KNOWN
				: {
						status: "unknown",
						reason:
							isExternAlias(directive.qualifier) || isExternalSpecifier(directive.specifier)
								? "ExternalDependency"
								: "NotIndexed",
					};
		return {
			kind: "named",
			...common,
			name: directive.nameToken.value,
			range: positionRange(directive.nameToken),
			...local,
			conflict: ALIASED,
			certainty,
		};
	}

	/** The namespace holding a directive. */
	private baseOf(facts: IndexedFacts, scopeId: string | undefined): string {
		const scope = scopeId === undefined ? undefined : facts.metadata.get(scopeId);
		return scope === undefined ? "" : joinNamespace(scope.namespaceName, scope.declaration.name);
	}

	/** A plain directive names only a namespace; an alias a namespace or a type; `using static` a type. */
	private reach(module: string, using: Using, base: string, plain: boolean): Reach {
		if (isExternAlias(using.qualifier)) return NONE;
		if (!using.static && using.target.every((segment) => segment.arity === 0)) {
			const namespace = this.usedNamespace(using, base);
			if (namespace !== undefined && this.index.isNamespace(namespace))
				return { kind: "namespace", landing: packageScope(namespace) };
		}
		if (plain) return NONE;
		const landings = new Map<string, Landing>();
		for (const type of this.resolveFrom(base, using.target, using.qualifier, module)) {
			const landing = using.static ? this.typeScope(type) : this.typeHome(type);
			if (landing !== undefined && !landings.has(landingKey(landing))) landings.set(landingKey(landing), landing);
		}
		return landings.size === 0 ? NONE : { kind: "types", landings: [...landings.values()] };
	}

	/** A type's own scope, which `using static` opens. */
	private typeScope(type: IndexedType): Landing | undefined {
		const at = this.typeAt(type.symbolId);
		if (at === undefined) return undefined;
		const scopeId = joinNamespace(at.meta.namespaceName, typeKey(at.meta));
		return { kind: "symbolScope", providerId: PROVIDER_ID, scopeId, anchorSymbolId: type.symbolId };
	}

	/** Where a type's name stands: the type around it, its namespace, or the module in the global namespace. */
	private typeHome(type: IndexedType): Landing | undefined {
		const at = this.typeAt(type.symbolId);
		if (at === undefined) return undefined;
		const { meta } = at;
		if (meta.typePath !== "")
			return {
				kind: "symbolScope",
				providerId: PROVIDER_ID,
				scopeId: joinNamespace(meta.namespaceName, meta.typePath),
				...(meta.parentId === undefined ? {} : { anchorSymbolId: meta.parentId }),
			};
		return meta.namespaceName === "" ? { kind: "module", module: at.module } : packageScope(meta.namespaceName);
	}
}
