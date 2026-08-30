import path from "node:path";
import type { Declaration, Import } from "@nyaa-lexicon/protocol";
import { type ProviderClaims, routeModule, routingContextOf } from "../routing";
import type { ProviderSupervisor } from "../supervisor";

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

/** `.fake` files: `export class X` declares, `import "./x"` imports, a `SYNTAX` line fails the parse, outline answers outline. */
export function fakeSupervisor(
	claims: ProviderClaims = FAKE_CLAIMS,
	discover: () => string[] = () => [],
): ProviderSupervisor {
	let evidence: () => Iterable<string> = () => [];
	let routing: ReturnType<typeof routingContextOf> | undefined;
	const context = () => {
		routing ??= routingContextOf(evidence());
		return routing;
	};
	return {
		running: () => [claims],
		route: (module: string) => routeModule(module, [claims], context()),
		evidenceFrom: (modules: () => Iterable<string>) => {
			evidence = modules;
		},
		observeWorkspace: (modules: Iterable<string>) => {
			routing = routingContextOf(modules);
		},
		observeModule: (module: string) => context().observe(module),
		askProvider: async () => ({ files: discover(), externalRoots: [], configFiles: [], diagnostics: [] }),
		ask: async (_module: string, method: string, params: unknown) => {
			if (method === "parseFile") {
				const request = params as {
					module: string;
					contentHash: string;
					text: string;
					depth?: "outline" | "surface";
				};
				return {
					module: request.module,
					contentHash: request.contentHash,
					...(request.depth === "outline" ? { depth: "outline" as const } : {}),
					declarations: parseClasses(request.module, request.text),
					references: [],
					imports: importsFrom(request.text),
					literals: [],
					diagnostics: request.text.includes("SYNTAX")
						? [{ severity: "error" as const, message: "syntax error" }]
						: [],
				};
			}
			if (method === "resolveImport") {
				const request = params as { fromModule: string; specifier: string };
				if (!request.specifier.startsWith(".")) return { status: "unresolved", reason: "NotImplemented" };
				return {
					status: "resolved",
					module: path.posix.normalize(
						path.posix.join(path.posix.dirname(request.fromModule), request.specifier),
					),
				};
			}
			throw new Error(`unexpected method ${method}`);
		},
		stopAll: () => {},
	} as unknown as ProviderSupervisor;
}
