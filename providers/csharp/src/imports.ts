// C# using directives: what each brings at each namespace level around a use, and what a directive's
// target names in the workspace.

import { type Binding, defined, type Reference, type UnknownReason } from "@nyaa-lexicon/protocol";
import { type CsharpImport, type DeclarationMeta, positionKey, type Segment, segmentKey } from "./model.js";
import { type GlobalUsing, type IndexedType, joinNamespace, namespaceLevels, typeKey } from "./namespaces.js";
import { CsharpWorkspace, type IndexedFacts } from "./workspace.js";

////////////////////////////////
//  Constants

const EXTERNAL_ROOTS = new Set([
	"Microsoft",
	"Newtonsoft",
	"NUnit",
	"System",
	"Windows",
	"Xunit",
	"xunit",
	"mscorlib",
	"netstandard",
]);

////////////////////////////////
//  Interfaces & Types

export type Using = Pick<CsharpImport, "specifier" | "alias" | "static" | "target" | "qualifier">;

/** What a using directive names. */
type Target = Pick<Using, "specifier" | "target" | "qualifier">;

/** A namespace level around a use, and what its using directives bring there. */
export interface Level {
	namespace: string;
	/** Each alias's first directive. */
	aliases: ReadonlyMap<string, Target>;
	/** Each namespace the directives bring, by the first one's place among them. */
	namespaces: ReadonlyMap<string, number>;
	/** Each type a `using static` names alone, as `namespace\0typeKey`, by the first one's place. */
	statics: ReadonlyMap<string, number>;
	/** The types each `using static` names, in directive order. */
	staticTypes: readonly (readonly string[])[];
}

////////////////////////////////
//  Functions & Helpers

export function unbound(reason: UnknownReason, detail: string): Binding {
	return { status: "unbound", reason, detail };
}

/** Bound to one, ambiguous among several; callers pass at least one. */
export function candidatesBinding(candidates: readonly { symbolId: string }[]): Binding {
	return candidates.length === 1
		? { status: "bound", symbolId: (candidates[0] as { symbolId: string }).symbolId, provenance: "bound" }
		: { status: "ambiguous", candidates: candidates.map((item) => item.symbolId), provenance: "bound" };
}

export function isExternalSpecifier(specifier: string): boolean {
	const dot = specifier.indexOf(".");
	return EXTERNAL_ROOTS.has(dot < 0 ? specifier : specifier.slice(0, dot));
}

/** An extern alias names another assembly, so nothing in the workspace. */
export function isExternAlias(qualifier: string | undefined): boolean {
	return qualifier !== undefined && qualifier !== "global";
}

/** The namespaces a name read from `base` settles in, innermost first; `global::` reads the global one alone. */
function readLevels(base: string, qualifier: string | undefined): string[] {
	if (qualifier === undefined) return namespaceLevels(base);
	return isExternAlias(qualifier) ? [] : [""];
}

////////////////////////////////
//  Classes

export abstract class CsharpImports extends CsharpWorkspace {
	/** A using directive's namespace, named by its first declaration; a type for `using static` or an alias. */
	protected importBinding(facts: IndexedFacts, reference: Reference, from: DeclarationMeta | undefined): Binding {
		const key = positionKey(reference.range.start);
		const directive = facts.imports.find((item) => positionKey(item.specifierToken.start) === key);
		const target = directive?.target ?? [{ name: reference.name, arity: 0 }];
		if (isExternAlias(directive?.qualifier))
			return unbound("ExternalDependency", "an extern alias names another assembly's namespace");
		// Read from the namespace holding the directive outward, until its first name settles; the
		// workspace before a known outside root.
		const scope = this.enclosingNamespace(facts, from);
		const base = scope === undefined ? "" : joinNamespace(scope.namespaceName, scope.declaration.name);
		for (const level of readLevels(base, directive?.qualifier)) {
			const name = joinNamespace(level, reference.name);
			const [declaration] = this.index.declarationsOf(name);
			if (declaration !== undefined) return candidatesBinding([declaration]);
			const types = this.settle(level, target, facts.module);
			if (types !== undefined && types.length > 0) return candidatesBinding(types);
			if (types === undefined && !this.index.isNamespace(joinNamespace(level, target[0]?.name ?? ""))) continue;
			if (this.index.isNamespace(name))
				return isExternalSpecifier(name)
					? unbound("ExternalDependency", "the workspace declares only a longer namespace inside it")
					: unbound("NotIndexed", "the namespace is declared only inside a longer name");
			break;
		}
		return isExternalSpecifier(reference.name)
			? unbound("ExternalDependency", "the namespace is outside the workspace")
			: unbound("NotIndexed", "the namespace is not indexed");
	}

	/**
	 * The namespace `A::` reads in: the one the nearest using alias A names. None when that alias
	 * names a type, or no using alias is A, as for an extern alias.
	 */
	protected aliasedNamespace(levels: readonly Level[], alias: string): string | undefined {
		for (const level of levels) {
			const target = level.aliases.get(alias);
			if (target === undefined) continue;
			const namespace = target.target.every((segment) => segment.arity === 0)
				? this.usedNamespace(target, level.namespace)
				: undefined;
			return namespace !== undefined && this.index.isNamespace(namespace) ? namespace : undefined;
		}
		return undefined;
	}

	/**
	 * The types a level's using directives bring of a name, in directive order: `using N;` brings N's
	 * types, and through them their nested ones, never N's namespaces; `using static T;` brings T's
	 * nested types. Read from the name's declarations, so the cost follows them, not the directives.
	 */
	protected usedTypes(level: Level, segments: readonly Segment[], module: string): IndexedType[] {
		const last = segments.at(-1);
		if (last === undefined) return [];
		const key = segmentKey(segments);
		const brought: { place: number; namespace: string; key: string }[] = [];
		for (const named of this.index.typesNamed(segmentKey([last]))) {
			if (this.meter !== undefined) this.meter.steps++;
			const place =
				named.key === key
					? level.namespaces.get(named.namespace)
					: named.key.endsWith(`.${key}`)
						? level.statics.get(`${named.namespace}\0${named.key.slice(0, -key.length - 1)}`)
						: undefined;
			if (place !== undefined) brought.push({ place, ...named });
		}
		brought.sort((left, right) => left.place - right.place);
		const types = brought.flatMap((item) => this.indexed(item.namespace, item.key, module));
		return [...new Map(types.map((type) => [type.symbolId, type])).values()];
	}

	/**
	 * A dotted name read at one namespace level: undefined when its first name means nothing there;
	 * else what the rest reaches from it, a namespace or a type, found or not.
	 */
	protected settle(namespace: string, segments: readonly Segment[], module: string): IndexedType[] | undefined {
		const [head, ...rest] = segments;
		if (head === undefined) return undefined;
		if (rest.length > 0 && head.arity === 0) {
			const inner = joinNamespace(namespace, head.name);
			if (this.index.isNamespace(inner)) return this.underNamespace(inner, rest, module);
		}
		if (rest.length > 0 && this.index.types(namespace, segmentKey([head]), module).length === 0) return undefined;
		const types = this.indexed(namespace, segmentKey(segments), module);
		return rest.length > 0 || types.length > 0 ? types : undefined;
	}

	/** A dotted name read inside a namespace: its leading names as namespaces inside it while they are. */
	protected underNamespace(namespace: string, segments: readonly Segment[], module: string): IndexedType[] {
		const [head, ...rest] = segments;
		if (head !== undefined && rest.length > 0 && head.arity === 0) {
			const inner = joinNamespace(namespace, head.name);
			if (this.index.isNamespace(inner)) return this.underNamespace(inner, rest, module);
		}
		return this.indexed(namespace, segmentKey(segments), module);
	}

	/** A dotted name read from a namespace outward as an alias or `using static` target reads. */
	protected resolveFrom(
		base: string,
		segments: readonly Segment[],
		qualifier: string | undefined,
		module: string,
	): IndexedType[] {
		for (const level of readLevels(base, qualifier)) {
			const types = this.settle(level, segments, module);
			if (types !== undefined) return types;
		}
		return [];
	}

	/**
	 * The levels around a namespace declaration, innermost first, with what the using directives at
	 * each bring; once per declaration and generation.
	 */
	protected levels(facts: IndexedFacts, scope: DeclarationMeta | undefined): Level[] {
		return this.store.memo(`levels\0${facts.module}\0${scope?.declaration.symbolId ?? ""}`, () =>
			this.directivesAround(facts, scope).map(({ namespace, usings }) => {
				const aliases = new Map<string, Target>();
				const namespaces = new Map<string, number>();
				const statics = new Map<string, number>();
				const staticTypes: string[][] = [];
				for (const [place, using] of usings.entries()) {
					if (using.static) {
						const types = this.resolveFrom(namespace, using.target, using.qualifier, facts.module);
						staticTypes.push(types.map((type) => type.symbolId));
						const at =
							using.alias === undefined && types.length === 1
								? this.typeAt(types[0]?.symbolId)
								: undefined;
						const key = at === undefined ? undefined : `${at.meta.namespaceName}\0${typeKey(at.meta)}`;
						if (key !== undefined && !statics.has(key)) statics.set(key, place);
					} else if (using.alias !== undefined) {
						const { specifier, target, qualifier } = using;
						if (!aliases.has(using.alias))
							aliases.set(using.alias, { specifier, target, ...defined({ qualifier }) });
					} else {
						const used = this.usedNamespace(using, namespace);
						if (used !== undefined && !namespaces.has(used)) namespaces.set(used, place);
					}
				}
				return { namespace, aliases, namespaces, statics, staticTypes };
			}),
		);
	}

	/** The levels around a namespace declaration, innermost first, each with the using directives it reads. */
	private directivesAround(
		facts: IndexedFacts,
		scope: DeclarationMeta | undefined,
	): { namespace: string; usings: Using[] }[] {
		const usings = new Map<string, Using[]>([
			[
				"",
				[
					...facts.imports.filter((using) => using.scopeId === undefined && !using.global),
					...this.globalUsings(facts.module),
				],
			],
		]);
		const seen = new Set<string>();
		for (let current = scope; current !== undefined && !seen.has(current.declaration.symbolId); ) {
			const id = current.declaration.symbolId;
			seen.add(id);
			const namespace = joinNamespace(current.namespaceName, current.declaration.name);
			const held = facts.imports.filter((using) => using.scopeId === id);
			usings.set(namespace, [...(usings.get(namespace) ?? []), ...held]);
			current = this.enclosingNamespace(
				facts,
				current.parentId === undefined ? undefined : facts.metadata.get(current.parentId),
			);
		}
		const innermost = scope === undefined ? "" : joinNamespace(scope.namespaceName, scope.declaration.name);
		return namespaceLevels(innermost).map((namespace) => ({ namespace, usings: usings.get(namespace) ?? [] }));
	}

	/** The `global using` directives of a module's project. */
	protected globalUsings(module: string): GlobalUsing[] {
		const project = this.projectOf(module);
		return this.index.globalUsings().filter((using) => this.projectOf(using.module) === project);
	}

	/**
	 * A using directive's namespace, read from the namespace holding it outward until its first name
	 * settles; none for an extern alias's.
	 */
	protected usedNamespace(using: Target, base: string): string | undefined {
		if (isExternAlias(using.qualifier)) return undefined;
		const head = using.target[0]?.name ?? using.specifier;
		for (const level of readLevels(base, using.qualifier))
			if (this.index.isNamespace(joinNamespace(level, head))) return joinNamespace(level, using.specifier);
		return using.specifier;
	}
}
