import path from "node:path";
import {
	type Declaration,
	type Import,
	METHOD_SCHEMAS,
	type ProviderMethod,
	type ProviderTiers,
} from "@nyaa-lexicon/protocol";
import type { MethodRequest, MethodResponse, ProviderPort } from "../providerPort";
import { type ProviderClaims, routeModule, routingContextOf } from "../routing";

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
	answers?: FakeAnswers;
	/** Whether the indexer's registered source feeds routing before a scan observed anything. */
	lazyEvidence?: boolean;
}

////////////////////////////////
//  Constants

export const FAKE_CLAIMS: ProviderClaims = { providerId: "fake", language: "fake", extensions: [".fake"] };

////////////////////////////////
//  Functions & Helpers

/** Classes with the span of their body, so two identical bodies digest alike and an edited one does not. */
export function parseClasses(module: string, text: string): Declaration[] {
	const lines = text.split("\n");
	const out: Declaration[] = [];
	for (const [line, source] of lines.entries()) {
		const match = /^export class ([A-Za-z_$][\w$]*)/.exec(source);
		if (match === null) continue;
		let end = line;
		while (end < lines.length - 1 && !(lines[end] as string).includes("}")) end++;
		const name = match[1] as string;
		out.push({
			symbolId: `lexicon fake ${module} ${name}#`,
			kind: "class",
			name,
			range: { start: { line, character: 0 }, end: { line: end, character: (lines[end] as string).length } },
			selectionRange: { start: { line, character: 13 }, end: { line, character: 13 + name.length } },
			visibility: "public",
			exported: true,
		});
	}
	return out;
}

export function importsFrom(text: string): Import[] {
	return [...text.matchAll(/import\s+["']([^"']+)["']/g)].map((match) => ({
		specifier: match[1] as string,
		imported: [],
		reExport: false,
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
		diagnostics: request.text.includes("SYNTAX") ? [{ severity: "error" as const, message: "syntax error" }] : [],
	};
}

/** The default resolution: a relative specifier joins its importer's directory; anything else is unresolved. */
export function resolveFake(request: MethodRequest<"resolveImport">): MethodResponse<"resolveImport"> {
	if (!request.specifier.startsWith(".")) return { status: "unresolved", reason: "NotImplemented" };
	return {
		status: "resolved",
		module: path.posix.normalize(path.posix.join(path.posix.dirname(request.fromModule), request.specifier)),
	};
}

function defaultAnswer<K extends ProviderMethod>(
	method: K,
	params: unknown,
	discover: () => string[],
): MethodResponse<K> {
	switch (method) {
		case "parseFile":
			return parseFake(params as MethodRequest<"parseFile">) as MethodResponse<K>;
		case "resolveImport":
			return resolveFake(params as MethodRequest<"resolveImport">) as MethodResponse<K>;
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
	const answers = options.answers ?? {};
	const lazyEvidence = options.lazyEvidence ?? true;
	let evidence: () => Iterable<string> = () => [];
	let routing: ReturnType<typeof routingContextOf> | undefined;
	const context = () => {
		routing ??= routingContextOf(evidence());
		return routing;
	};

	async function answer<K extends ProviderMethod>(
		module: string,
		method: K,
		params: unknown,
	): Promise<MethodResponse<K>> {
		const override = answers[method] as Answer<K> | undefined;
		const answered =
			override !== undefined
				? await override(params as MethodRequest<K>, module)
				: defaultAnswer(method, params, discover);
		// The declared tier owns the comments field, exactly as the supervisor settles it at the wire.
		if (method === "parseFile") {
			const facts = answered as MethodResponse<"parseFile">;
			if (tiers.comments === true) facts.comments ??= [];
			else delete facts.comments;
		}
		// Validated as the wire validates it, so no fixture can assert on a shape a provider cannot send.
		return METHOD_SCHEMAS[method].response.parse(answered) as MethodResponse<K>;
	}

	const port: ProviderPort = {
		running: () => claims,
		route: (module) => routeModule(module, claims, context()),
		evidenceFrom: (modules) => {
			if (lazyEvidence) evidence = modules;
		},
		observeWorkspace: (modules) => {
			routing = routingContextOf(modules);
		},
		observeModule: (module) => context().observe(module),
		declares: (_providerId, tier) => tiers[tier] === true,
		ask: async (module, method, params) => {
			// Unowned refuses here as it does live, so no suite proves a path the daemon cannot reach.
			const route = port.route(module);
			if (!route.owned) {
				const detail =
					route.reason === "contested" ? `claimed by ${route.providerIds.join(", ")}` : "unclaimed";
				throw new Error(`no provider owns ${module}: ${detail}`);
			}
			return answer(module, method, params);
		},
		askProvider: async (providerId, method, params) => {
			if (!claims.some((claim) => claim.providerId === providerId)) {
				throw new Error(`provider ${providerId} is not running`);
			}
			return answer(providerId, method, params);
		},
	};
	return port;
}
