import path from "node:path";
import {
	coordinatesOf,
	type Declaration,
	type Import,
	METHOD_SCHEMAS,
	type ModuleAdmission,
	NOTIFICATION_SCHEMAS,
	type ProviderMethod,
	type ProviderTiers,
	type ProviderWords,
	type Range,
	unjudgedLoadCycle,
} from "@nyaa-lexicon/protocol";
import { DeadlineError } from "../deadline";
import { settleDeclaredTiers } from "../declaredTiers";
import type { MethodRequest, MethodResponse, ProviderPort } from "../providerPort";
import { type HeadReader, type ProviderClaims, routeModule, routingContextOf } from "../routing";
import { ProviderUnavailableError } from "../supervisor";
import { fakeClasses, fakeImports } from "./fakeGrammar";

////////////////////////////////
//  Interfaces & Types

/** A handler per method a test overrides; `module` is the one asked about. */
export type FakeAnswers = {
	[K in ProviderMethod]?: (
		params: MethodRequest<K>,
		module: string,
	) => MethodResponse<K> | Promise<MethodResponse<K>>;
};

type Answer<K extends ProviderMethod> = (
	params: MethodRequest<K>,
	module: string,
) => MethodResponse<K> | Promise<MethodResponse<K>>;

export interface FakeOptions {
	/** What runs, routes and answers; one set, as a live provider set has. */
	claims?: ProviderClaims[];
	discover?: () => string[];
	/** What `declares` answers; an omitted tier is undeclared. */
	tiers?: Partial<ProviderTiers>;
	/** What `words` answers; defaults to every list empty. */
	words?: ProviderWords;
	answers?: FakeAnswers;
	/** Failures the live supervisor can expose while a request is pending. */
	fail?: { providerDown?: boolean; timeoutMs?: number; queue?: number };
	/** Whether the indexer's registered source feeds routing before a scan observed anything. */
	lazyEvidence?: boolean;
	/** Each module the index told providers to forget. */
	forgotten?: string[];
	/** Each module the index told its former owner to release. */
	released?: Array<{ module: string; providerId: string }>;
	/** Each provider root list sent by the indexer, in order. */
	indexedRoots?: Array<{ providerId: string; roots: string[] }>;
	/** Each partial judgment the index told its provider to drop. */
	releasedJudgments?: Array<{ providerId: string; partial: string }>;
	releasedPreviews?: Array<{ providerId: string; preview: string }>;
	/** Each verdict DELIVERED, with the provider it named, in order. */
	admissions?: Array<{ providerId: string; verdict: ModuleAdmission }>;
	/** Which spawn answers now. A test advances it to restart a provider under the same id. */
	incarnation?: { current: number };
	/** Filled in with a respawn: it advances `incarnation` and tells whoever listens, as a restart does. */
	respawns?: { respawn?: (providerId: string) => void };
}

////////////////////////////////
//  Constants

export const FAKE_CLAIMS: ProviderClaims = { providerId: "fake", language: "fake", extensions: [".fake"] };

////////////////////////////////
//  Functions & Helpers

/** Ranges of `text` by offset; a fake's own scan never names one outside it. */
export function rangesOf(text: string): (start: number, end: number) => Range {
	const coordinates = coordinatesOf(text);
	return (start, end) => {
		const range = coordinates.rangeAt(start, end);
		if (range === undefined) throw new Error(`unaddressable fake range: ${start} to ${end}`);
		return range;
	};
}

/** Classes with the span of their body, so two identical bodies digest alike and an edited one does not. */
export function parseClasses(module: string, text: string): Declaration[] {
	const rangeOf = rangesOf(text);
	return fakeClasses(text).map((found) => ({
		symbolId: `lexicon fake ${module} ${found.name}#`,
		kind: "class",
		name: found.name,
		range: rangeOf(found.start, found.end),
		selectionRange: rangeOf(found.nameStart, found.nameStart + found.name.length),
		visibility: "public",
		exported: true,
	}));
}

/** Each `import "x"` as one side-effect edge spanning the statement. */
export function importsFrom(text: string): Import[] {
	const rangeOf = rangesOf(text);
	return fakeImports(text).map((found, order) => ({
		specifier: found.specifier,
		edges: [
			{
				kind: "sideEffect",
				span: rangeOf(found.start, found.end),
				bindsLocally: false,
				certainty: { status: "known" },
				order,
			},
		],
	}));
}

/** The default parse: `export class X` declares, `import "./x"` imports, a `SYNTAX` line fails, an outline answers outline. */
export function parseFake(request: MethodRequest<"parseFile">): MethodResponse<"parseFile"> {
	return {
		module: request.module,
		contentHash: request.contentHash,
		...(request.depth === "outline" ? { depth: "outline" as const } : {}),
		declarations: parseClasses(request.module, request.text),
		references: [],
		imports: importsFrom(request.text),
		literals: [],
		// A sentinel anywhere in the text, comments included, not a structure the grammar reads.
		diagnostics: request.text.includes("SYNTAX") ? [{ severity: "error" as const, message: "syntax error" }] : [],
	};
}

/** The default resolution: a relative specifier joins its importer's directory; anything else is unresolved. */
export function resolveFake(request: MethodRequest<"resolveImport">): MethodResponse<"resolveImport"> {
	if (!request.specifier.startsWith(".")) return { status: "unresolved", reason: "NotImplemented" };
	return {
		status: "resolved",
		landing: {
			kind: "module",
			module: path.posix.normalize(path.posix.join(path.posix.dirname(request.fromModule), request.specifier)),
		},
	};
}

function defaultAnswer<K extends ProviderMethod>(
	method: K,
	params: unknown,
	discover: () => string[],
): MethodResponse<K> {
	switch (method) {
		case "parseFile":
		case "probeFile":
			return parseFake(params as MethodRequest<"parseFile">) as MethodResponse<K>;
		case "resolveImport":
			return resolveFake(params as MethodRequest<"resolveImport">) as MethodResponse<K>;
		case "judgeLoadCycle":
			return unjudgedLoadCycle(params as MethodRequest<"judgeLoadCycle">) as MethodResponse<K>;
		case "discoverProject":
			return { files: discover(), externalRoots: [], configFiles: [], diagnostics: [] } as MethodResponse<K>;
		default:
			throw new Error(`unexpected method ${method}`);
	}
}

/** A provider set that answers from `options`, or from the defaults above, or throws as an unexpected ask. */
export function fakeSupervisor(options: FakeOptions = {}): ProviderPort {
	const claims = options.claims ?? [FAKE_CLAIMS];
	const discover = options.discover ?? (() => []);
	const tiers = options.tiers ?? {};
	const words = options.words ?? { keywords: [], builtins: [], literals: [] };
	const answers = options.answers ?? {};
	const failure = options.fail ?? {};
	const incarnation = options.incarnation ?? { current: 1 };
	const lazyEvidence = options.lazyEvidence ?? true;
	let respawned: ((providerId: string) => void) | undefined;
	if (options.respawns !== undefined) {
		options.respawns.respawn = (providerId) => {
			incarnation.current++;
			respawned?.(providerId);
		};
	}
	let evidence: () => Iterable<string> = () => [];
	let head: HeadReader | undefined;
	let routing: ReturnType<typeof routingContextOf> | undefined;
	const context = () => {
		routing ??= routingContextOf(evidence(), head);
		return routing;
	};

	async function answer<K extends ProviderMethod>(
		module: string,
		method: K,
		params: unknown,
	): Promise<MethodResponse<K>> {
		if (failure.providerDown) throw new ProviderUnavailableError("provider exited");
		if (failure.queue !== undefined && failure.queue > 0) {
			failure.queue--;
			await new Promise<void>((resolve) => setTimeout(resolve, failure.timeoutMs ?? 0));
		}
		const override = answers[method] as Answer<K> | undefined;
		const answered =
			override !== undefined
				? await override(params as MethodRequest<K>, module)
				: defaultAnswer(method, params, discover);
		if (method === "parseFile" || method === "probeFile") {
			settleDeclaredTiers(tiers, answered as MethodResponse<"parseFile">);
		}
		// Validated as the wire validates it, so no fixture can assert on a shape a provider cannot send.
		return METHOD_SCHEMAS[method].response.parse(answered) as MethodResponse<K>;
	}

	function pending<K extends ProviderMethod>(work: Promise<MethodResponse<K>>): Promise<MethodResponse<K>> {
		if (failure.timeoutMs === undefined) return work;
		return Promise.race([
			work,
			new Promise<MethodResponse<K>>((_, reject) =>
				setTimeout(() => reject(new DeadlineError("provider request timed out")), failure.timeoutMs),
			),
		]);
	}

	const port: ProviderPort = {
		running: () => claims,
		route: (module) => routeModule(module, claims, context()),
		evidenceFrom: (modules) => {
			if (lazyEvidence) evidence = modules;
		},
		headFrom: (read) => {
			head = read;
		},
		observeWorkspace: (modules) => {
			routing = routingContextOf(modules, head);
		},
		observeModule: (module) => context().observe(module),
		declares: (_providerId, tier) => tiers[tier] === true,
		words: (providerId) => (claims.some((claim) => claim.providerId === providerId) ? words : undefined),
		ask: async (module, method, params) => {
			// Unowned refuses here as it does live, so no suite proves a path the daemon cannot reach.
			const route = port.route(module);
			if (!route.owned) {
				const detail =
					route.reason === "contested" ? `claimed by ${route.providerIds.join(", ")}` : "unclaimed";
				throw new Error(`no provider owns ${module}: ${detail}`);
			}
			return pending(answer(module, method, params));
		},
		askProvider: async (providerId, method, params) => {
			if (!claims.some((claim) => claim.providerId === providerId)) {
				throw new Error(`provider ${providerId} is not running`);
			}
			return pending(answer(providerId, method, params));
		},
		forget: (module) => {
			options.forgotten?.push(module);
		},
		release: (module, providerId) => {
			options.released?.push({ module, providerId });
		},
		indexRoots: (providerId, roots) => {
			options.indexedRoots?.push({ providerId, roots: [...roots] });
		},
		releaseJudgment: (providerId, given, partial) => {
			if (given === incarnation.current) options.releasedJudgments?.push({ providerId, partial });
		},
		releaseLoadCyclePreview: (providerId, given, preview) => {
			if (given === incarnation.current) options.releasedPreviews?.push({ providerId, preview });
		},
		incarnationOf: () => incarnation.current,
		respawnedFrom: (listener) => {
			respawned = listener;
		},
		admission: (providerId, given, verdict) => {
			// Dropped as the supervisor drops it: a verdict for a process that has been replaced.
			if (given !== incarnation.current) return;
			// Parsed as the wire parses it, so no suite asserts on a verdict a provider cannot receive.
			options.admissions?.push({ providerId, verdict: NOTIFICATION_SCHEMAS.moduleAdmission.parse(verdict) });
		},
		providerStatuses: () =>
			claims.map((claim) => ({ id: claim.providerId, language: claim.language, phase: "ready", pending: 0 })),
	};
	return port;
}
