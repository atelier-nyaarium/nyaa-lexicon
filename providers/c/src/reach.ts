import { isDeepStrictEqual } from "node:util";
import type { Conflict, Import, ImportResolution, UnknownReason, WorkMeter } from "@nyaa-lexicon/protocol";
import type { CDeclaration, CImportFact, ParsedCFile } from "./model.js";
import { type CProject, contextOf, type Found, type IncludeKind, type SearchContext } from "./project.js";
import { lexicalScope } from "./scopes.js";

////////////////////////////////
//  Interfaces & Types

/** What a module reaches through its includes, and why any include reached none. */
interface Reach {
	/** Each name's file-scope declarations, by include depth. */
	names: Map<string, CDeclaration[][]>;
	/** An include landed outside the workspace. */
	external: boolean;
	/** A header could not be read yet, so the reach is not worth keeping. */
	incomplete: boolean;
	reason?: UnknownReason;
	detail?: string;
}

/** The lookups a module reach needs from its owner. */
export interface ReachSources {
	store: { project: CProject; memo<T>(key: string, build: () => T): T };
	meter?: WorkMeter;
	factsForModule(module: string): ParsedCFile | null;
	forcedIncludes(module: string): Array<{ written: string; resolution: ImportResolution }>;
	resolveInclude(
		context: SearchContext,
		fromModule: string,
		name: string,
		kind: IncludeKind | undefined,
	): ImportResolution;
}

////////////////////////////////
//  Constants

/** A name two headers declare is no single declaration; a local one hides an included one. */
const INCLUDE_CONFLICT: Conflict = { priority: 0, amongTransfers: "exclude", againstLocal: "localWins" };

const COMMON_HEADERS = new Set([
	"assert.h",
	"complex.h",
	"ctype.h",
	"errno.h",
	"fcntl.h",
	"inttypes.h",
	"limits.h",
	"math.h",
	"memory.h",
	"pthread.h",
	"setjmp.h",
	"signal.h",
	"stdarg.h",
	"stdbool.h",
	"stddef.h",
	"stdint.h",
	"stdio.h",
	"stdlib.h",
	"string.h",
	"sys/types.h",
	"time.h",
	"unistd.h",
	"wchar.h",
	"windows.h",
]);

////////////////////////////////
//  Functions & Helpers

function headerName(specifier: string): string {
	if (
		(specifier.startsWith("<") && specifier.endsWith(">")) ||
		(specifier.startsWith('"') && specifier.endsWith('"'))
	) {
		return specifier.slice(1, -1);
	}
	return specifier;
}

/** An include injects all declarations of its header into the includer. */
function includeImport({ specifier, span }: CImportFact, order: number): Import {
	return {
		specifier,
		edges: [
			{
				kind: "injection",
				span,
				selector: { kind: "visible" },
				bindsLocally: true,
				conflict: INCLUDE_CONFLICT,
				certainty: { status: "known" },
				order,
			},
		],
	};
}

/** What finding `name`, or not, means for an include of `kind`. */
function resolutionOf(found: Found | undefined, name: string, kind: IncludeKind | undefined): ImportResolution {
	if (found !== undefined && "module" in found)
		return { status: "resolved", landing: { kind: "module", module: found.module } };
	if (found !== undefined || kind === "angle") return { status: "external", packageName: name };
	const common =
		COMMON_HEADERS.has(name) || name.startsWith("sys/") || name.startsWith("linux/") || name.startsWith("windows/");
	if (kind === undefined && common) return { status: "external", packageName: name };
	return { status: "unresolved", reason: "NotIndexed", detail: `no workspace header matches ${name}` };
}

/** The one answer every reading gives, or Ambiguous when they differ. */
function agreed(answers: readonly ImportResolution[], detail: string): ImportResolution {
	const first = answers[0] as ImportResolution;
	return answers.every((answer) => isDeepStrictEqual(answer, first))
		? first
		: { status: "unresolved", reason: "Ambiguous", detail };
}

class CReach {
	private readonly store: ReachSources["store"];
	private readonly meter: WorkMeter | undefined;

	constructor(private readonly sources: ReachSources) {
		this.store = sources.store;
		this.meter = sources.meter;
	}

	private factsForModule(module: string): ParsedCFile | null {
		return this.sources.factsForModule(module);
	}

	private forcedIncludes(module: string): Array<{ written: string; resolution: ImportResolution }> {
		return this.sources.forcedIncludes(module);
	}

	private resolveInclude(
		context: SearchContext,
		fromModule: string,
		name: string,
		kind: IncludeKind | undefined,
	): ImportResolution {
		return this.sources.resolveInclude(context, fromModule, name, kind);
	}

	run(module: string, facts: ParsedCFile): Reach {
		return this.reached(module, facts);
	}

	/**
	 * Breadth first, one depth per include level, every header searched with `module`'s own lists; a
	 * unit's forced includes come first. A header seen once is not walked again. The file-scope
	 * declarations reached are indexed by name and depth, once.
	 */
	private walkIncludes(module: string, facts: ParsedCFile): Reach {
		const project = this.store.project;
		const context = contextOf(project, module);
		const reach: Reach = { names: new Map(), external: false, incomplete: false };
		const seen = new Set([module]);
		let depth = 0;
		let frontier: Array<{ from: string; imports: readonly CImportFact[] }> = [];
		const visit = (resolution: ImportResolution, written: string) => {
			if (resolution.status === "external") reach.external = true;
			if (resolution.status === "unresolved") {
				reach.reason = resolution.reason;
				reach.detail = resolution.detail ?? `no workspace header matches ${written}`;
			}
			if (resolution.status !== "resolved" || resolution.landing.kind !== "module") return;
			const { module: landed } = resolution.landing;
			if (seen.has(landed)) return;
			seen.add(landed);
			const header = this.factsForModule(landed);
			if (header === null) {
				reach.reason = "NotIndexed";
				reach.detail = `the included module ${landed} is not indexed`;
				reach.incomplete = true;
				return;
			}
			frontier.push({ from: landed, imports: header.imports });
			for (const declaration of header.declarations) {
				if (this.meter !== undefined) this.meter.steps++;
				const lexical = lexicalScope(header, declaration);
				const fileScope =
					declaration.containerId === undefined || (lexical !== undefined && lexical.scope === undefined);
				if (!fileScope || declaration.exported === false) continue;
				const depths = reach.names.get(declaration.name) ?? [];
				reach.names.set(declaration.name, depths);
				const atDepth = depths[depth] ?? [];
				depths[depth] = atDepth;
				atDepth.push(declaration);
			}
		};
		for (const { written, resolution } of this.forcedIncludes(module)) visit(resolution, written);
		let reading: typeof frontier = [{ from: module, imports: facts.imports }];
		while (reading.length > 0) {
			for (const { from, imports } of reading)
				for (const imported of imports)
					visit(this.resolveInclude(context, from, imported.specifier, imported.kind), imported.specifier);
			reading = frontier;
			frontier = [];
			depth++;
		}
		return reach;
	}

	/** What `module` includes, through its headers' own includes; one walk per module and store generation. */
	private reached(module: string, facts: ParsedCFile): Reach {
		const held = this.store.memo(`\u0000reach\u0000${module}`, () => ({
			facts,
			reach: this.walkIncludes(module, facts),
		}));
		// A probe's text is not the held one, and a header that could not be read may read next time.
		return held.facts === facts && !held.reach.incomplete ? held.reach : this.walkIncludes(module, facts);
	}
}

export function createReach(sources: ReachSources): (module: string, facts: ParsedCFile) => Reach {
	const reach = new CReach(sources);
	return (module, facts) => reach.run(module, facts);
}

export { agreed, headerName, includeImport, type Reach, resolutionOf };
