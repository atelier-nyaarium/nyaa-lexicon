import {
	type Binding,
	defined,
	type ImportResolution,
	parseSymbolId,
	type Range,
	type Reference,
	type UnknownReason,
	type WorkMeter,
} from "@nyaa-lexicon/protocol";
import type { CDeclaration, CReference, ParsedCFile, TypeName } from "./model.js";
import { bindingCandidates, rangeContains } from "./parser.js";
import type { Reach } from "./reach.js";
import { declaredIn, macrosFirst, oneType, typeCandidates, typeMacros } from "./scopes.js";

////////////////////////////////
//  Interfaces & Types

/** A declaration and the facts of the module that holds it. */
interface Declared {
	module: string;
	facts: ParsedCFile;
	declaration: CDeclaration;
}

/** Why a receiver's type has no fields to bind. */
interface NoOwner {
	reason: UnknownReason;
	detail: string;
}

/** Facts binding reads outside the file it binds. */
export interface BindingSources {
	factsForModule(module: string): ParsedCFile | null;
	resolveImport(params: { fromModule: string; specifier: string }): ImportResolution;
	reached(module: string, facts: ParsedCFile): Reach;
}

////////////////////////////////
//  Constants

/** How many members and typedefs a receiver's type is followed through. */
const MAX_MEMBER_CHAIN = 16;

const TAG_KINDS: ReadonlySet<string> = new Set(["struct", "enum"]);

////////////////////////////////
//  Functions & Helpers

function containsStart(range: Range, position: Range["start"]): boolean {
	return rangeContains(range, position);
}

function referenceWire(reference: CReference, binding: Binding): Reference {
	return {
		name: reference.name,
		range: reference.range,
		role: reference.role,
		binding,
		...defined({ fromId: reference.fromId }),
		qualified: reference.qualified,
	};
}

function unknownBinding(reason: UnknownReason, detail: string): Binding {
	return { status: "unbound", reason, detail };
}

function conditionalAmbiguity(candidates: CDeclaration[]): Binding {
	return {
		status: "ambiguous",
		candidates: candidates.map((candidate) => candidate.symbolId),
		provenance: "bound",
		...({ detail: "conditional compilation supplies both declarations" } as object),
	} as Binding;
}

function ordinaryAmbiguity(candidates: CDeclaration[]): Binding {
	return {
		status: "ambiguous",
		candidates: candidates.map((candidate) => candidate.symbolId),
		provenance: "bound",
	} as Binding;
}

/** The types among `candidates` a tag, or else an ordinary name, can mean: a typedef before a bare tag. */
function inNamespace(candidates: CDeclaration[], tag: boolean): CDeclaration[] {
	const tags = candidates.filter((candidate) => TAG_KINDS.has(candidate.kind));
	if (tag) return tags;
	const aliases = candidates.filter((candidate) => candidate.kind === "class");
	return aliases.length > 0 ? aliases : tags;
}

////////////////////////////////
//  Classes

export class CBinding {
	constructor(
		private readonly sources: BindingSources,
		private readonly meter?: WorkMeter,
	) {}

	private factsForModule(module: string): ParsedCFile | null {
		return this.sources.factsForModule(module);
	}

	private resolveImport(params: { fromModule: string; specifier: string }): ImportResolution {
		return this.sources.resolveImport(params);
	}

	private reached(module: string, facts: ParsedCFile): Reach {
		return this.sources.reached(module, facts);
	}

	private bindingForReference(
		module: string,
		facts: ParsedCFile,
		reference: CReference,
		cache: Map<string, Binding>,
	): Binding {
		if (reference.member === true) return this.memberBinding(module, facts, reference, cache, 0);
		if (reference.role === "import") return this.includeBinding(module, reference);
		// Depends on where the reference is, so never cached.
		const sameFile = bindingCandidates(facts, reference);
		if (sameFile.length === 1)
			return { status: "bound", symbolId: (sameFile[0] as CDeclaration).symbolId, provenance: "bound" };
		if (sameFile.length > 1) {
			const conditional = sameFile.some((candidate) => candidate.conditionalGroup !== "");
			return conditional ? conditionalAmbiguity(sameFile) : ordinaryAmbiguity(sameFile);
		}
		const cacheKey = `${reference.name}\u0000${reference.role}\u0000${reference.tag === true}`;
		const cached = cache.get(cacheKey);
		if (cached !== undefined) return cached;
		const result = this.includedBinding(module, facts, reference);
		cache.set(cacheKey, result);
		return result;
	}

	references(
		params: { module: string },
		parsed: ParsedCFile,
		bindingCache: Map<string, Binding>,
	): { references: Reference[] } {
		return {
			references: parsed.references.map((reference) =>
				referenceWire(reference, this.bindingForReference(params.module, parsed, reference, bindingCache)),
			),
		};
	}

	/** A member binds to a field of its receiver's type, never to anything else of its name. */
	private memberBinding(
		module: string,
		facts: ParsedCFile,
		reference: CReference,
		cache: Map<string, Binding>,
		depth: number,
	): Binding {
		const receiver = reference.receiver === undefined ? undefined : facts.referencesByToken.get(reference.receiver);
		if (receiver === undefined)
			return unknownBinding("NotImplemented", "a member of a computed receiver is not resolved");
		if (depth > MAX_MEMBER_CHAIN) return unknownBinding("RecursionLimit", "the member chain is too long");
		const binding =
			receiver.member === true
				? this.memberBinding(module, facts, receiver, cache, depth + 1)
				: this.bindingForReference(module, facts, receiver, cache);
		if (binding.status === "unbound" || binding.status === "unknown") return binding;
		if (binding.status === "ambiguous")
			return unknownBinding("Ambiguous", `the receiver of ${reference.name} has more than one declaration`);
		const owner = this.memberOwner(this.declared(module, facts, binding.symbolId), 0);
		if ("reason" in owner) return unknownBinding(owner.reason, owner.detail);
		const fields = declaredIn(owner.facts, reference.name, owner.declaration.symbolId).filter(
			(declaration) => declaration.kind === "field",
		);
		if (fields.length === 1)
			return { status: "bound", symbolId: (fields[0] as CDeclaration).symbolId, provenance: "bound" };
		if (fields.length > 1) {
			const conditional = fields.some((candidate) => candidate.conditionalGroup !== "");
			return conditional ? conditionalAmbiguity(fields) : ordinaryAmbiguity(fields);
		}
		return unknownBinding("NotIndexed", `the receiver's type has no field ${reference.name}`);
	}

	/** The declaration `symbolId` names, with the facts that hold it. */
	private declared(module: string, facts: ParsedCFile, symbolId: string): Declared | undefined {
		const home = parseSymbolId(symbolId)?.module ?? module;
		const held = home === module ? facts : this.factsForModule(home);
		const declaration = held?.declarationsById.get(symbolId);
		return held === null || declaration === undefined ? undefined : { module: home, facts: held, declaration };
	}

	/** The declaration whose fields a value of `typed`'s type holds, through typedefs and forward declarations. */
	private memberOwner(typed: Declared | undefined, depth: number): Declared | NoOwner {
		if (typed === undefined) return { reason: "NotIndexed", detail: "the receiver has no indexed declaration" };
		if (depth > MAX_MEMBER_CHAIN)
			return { reason: "RecursionLimit", detail: "the receiver's type chain is too long" };
		const { module, facts, declaration } = typed;
		// An anonymous body's fields sit under what it declared.
		if ((facts.childrenById.get(declaration.symbolId) ?? []).some((child) => child.kind === "field")) return typed;
		const answer = declaration.kind === "struct" ? undefined : facts.typeAnswers.get(declaration.symbolId);
		if (answer?.fieldsOf !== undefined)
			return this.memberOwner(this.declared(module, facts, answer.fieldsOf), depth + 1);
		const type: TypeName | undefined =
			declaration.kind === "struct" ? { name: declaration.name, tag: true } : answer?.typeName;
		if (type === undefined) return { reason: "NotIndexed", detail: `${declaration.name} has no named type` };
		// A forward declaration's completion may follow it; a specifier is read where it is written.
		const place =
			declaration.kind === "struct"
				? { scopeId: declaration.containerId }
				: { scopeId: declaration.containerId, at: declaration.selectionIndex };
		let found = typeCandidates(facts, type.name, type.tag, place).filter(
			(candidate) => candidate.symbolId !== declaration.symbolId,
		);
		if (found.length === 0) {
			const imported = this.crossFileCandidates(module, facts, type.name, (declared) =>
				inNamespace(declared, type.tag),
			);
			found = imported.candidates;
			if (found.length === 0 && imported.external)
				return { reason: "ExternalDependency", detail: `${type.name} is declared in an external header` };
			if (found.length === 0)
				return { reason: imported.reason ?? "NotIndexed", detail: imported.detail ?? `no C type ${type.name}` };
		}
		const next = oneType(found);
		return next === undefined
			? { reason: "Ambiguous", detail: `${type.name} has more than one declaration` }
			: this.memberOwner(this.declared(module, facts, next.symbolId), depth + 1);
	}

	private includeBinding(module: string, reference: CReference): Binding {
		const resolution = this.resolveImport({ fromModule: module, specifier: reference.name });
		if (resolution.status === "external")
			return unknownBinding("ExternalDependency", "the included header is outside the workspace");
		if (resolution.status === "unresolved")
			return unknownBinding(resolution.reason, resolution.detail ?? "the included header is unresolved");
		return unknownBinding("NotIndexed", "an include path does not name a declaration");
	}

	/** A name no declaration in this file answers, looked up in what it includes. */
	private includedBinding(module: string, facts: ParsedCFile, reference: CReference): Binding {
		const tag = reference.tag === true;
		const imported =
			reference.role === "typeUse"
				? this.crossFileCandidates(module, facts, reference.name, (found) => {
						const types = inNamespace(found, tag);
						return types.length > 0 || tag ? types : typeMacros(found);
					})
				: this.crossFileCandidates(module, facts, reference.name, macrosFirst);
		if (imported.candidates.length === 1)
			return {
				status: "bound",
				symbolId: (imported.candidates[0] as CDeclaration).symbolId,
				provenance: "bound",
			};
		if (imported.candidates.length > 1) return ordinaryAmbiguity(imported.candidates);
		if (imported.external)
			return unknownBinding(
				"ExternalDependency",
				`no indexed declaration for ${reference.name} was found in an external header`,
			);
		if (imported.reason !== undefined)
			return unknownBinding(imported.reason, imported.detail ?? "the imported declaration is unresolved");
		return unknownBinding("NotIndexed", `no C declaration matches ${reference.name}`);
	}

	/**
	 * `name` in what `module` includes: the nearest include depth holding any `accept` keeps, so a
	 * header included directly outranks a platform twin further in.
	 */
	private crossFileCandidates(
		module: string,
		facts: ParsedCFile,
		name: string,
		accept: (found: CDeclaration[]) => CDeclaration[] = (found) => found,
	): { candidates: CDeclaration[]; external: boolean; reason?: UnknownReason; detail?: string } {
		const { names, external, reason, detail } = this.reached(module, facts);
		const unfound = { candidates: [], external, ...defined({ reason, detail }) };
		const depths = names.get(name) ?? [];
		for (let depth = 0; depth < depths.length; depth++) {
			if (this.meter !== undefined) this.meter.steps++;
			const declared = depths[depth];
			const candidates = declared === undefined ? [] : accept(declared);
			if (candidates.length > 0) return { ...unfound, candidates };
		}
		return unfound;
	}

	bind(params: { module: string; name: string; range: Range }): Binding {
		const facts = this.factsForModule(params.module);
		if (facts === null) return unknownBinding("NotIndexed", "module is not indexed");
		const reference = facts.references.find(
			(candidate) => candidate.name === params.name && containsStart(candidate.range, params.range.start),
		);
		if (reference !== undefined) return this.bindingForReference(params.module, facts, reference, new Map());
		// Every declaration this provider extracts has its name in the source.
		const declaration = facts.declarations.find(
			(candidate) =>
				candidate.name === params.name &&
				containsStart(candidate.selectionRange ?? candidate.range, params.range.start),
		);
		if (declaration !== undefined) return { status: "bound", symbolId: declaration.symbolId, provenance: "bound" };
		return unknownBinding("NotIndexed", "no indexed reference or declaration matched the requested range");
	}
}

export { containsStart };
