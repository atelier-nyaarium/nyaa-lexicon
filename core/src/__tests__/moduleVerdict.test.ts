import { describe, expect, it } from "bun:test";
import type { MethodResponse } from "../providerPort";
import type { ModuleVerdict, StoredFailure } from "../secretPolicy";
import { fromText, hashOfView, type SealedRead, sourceReadBytes } from "../sourceRead";
import { testPolicy } from "./testPolicy";

/** Module verdict routing and failures. */

////////////////////////////////
//  Helpers

const snapshot = testPolicy(".", { secrets: {}, deny: ["denied/**"] }).current;

const text = (module: string, body: string): SealedRead => fromText(() => body)(module);

const missing = (module: string): SealedRead => fromText(() => null)(module);

const binary = (module: string): SealedRead => sourceReadBytes(module, null);

const SECRET = "kind: Secret\ndata:\n  token: VALUE\n";

const CONFIG_MAP = "kind: ConfigMap\ndata:\n  token: VALUE\n";

const DOTENV = "TOKEN=hunter2\n";

const FACTS: MethodResponse<"parseFile"> = {
	module: "deploy.yaml",
	contentHash: "h",
	declarations: [],
	references: [],
	imports: [],
	literals: [
		{
			kind: "string",
			value: "VALUE",
			range: { start: { line: 2, character: 9 }, end: { line: 2, character: 14 } },
		},
	],
	comments: [],
	diagnostics: [{ severity: "warning", message: 'unexpected near "VALUE"' }],
};

/** Requires the provider route. */
function parsed(verdict: ModuleVerdict) {
	if (verdict.route !== "provider") throw new Error(`expected the provider route, got ${verdict.route}`);
	return verdict;
}

/** Hashes a read's view. */
function hashed(read: SealedRead): string {
	const hash = hashOfView(snapshot.view(read));
	if (hash === null) throw new Error("expected a read that found text");
	return hash;
}

/** Gets verdict failure text. */
const words = (verdict: ModuleVerdict, error: unknown): string => verdict.failure(error);

////////////////////////////////
//  Tests

describe("the route a verdict gives a module", () => {
	it("follows what the bytes read as", () => {
		const routes = {
			plain: snapshot.verdict(text("src/a.ts", "export const a = 1;\n")).route,
			keyPath: snapshot.verdict(text("deploy.yaml", SECRET)).route,
			configMap: snapshot.verdict(text("deploy.yaml", CONFIG_MAP)).route,
			wholeFile: snapshot.verdict(text(".env.local", DOTENV)).route,
		};

		expect(routes).toEqual({ plain: "provider", keyPath: "provider", configMap: "provider", wholeFile: "reader" });
	});

	it("routes omissions without providers and withholds unreadable files", () => {
		const routes = {
			omitted: snapshot.verdict(text("denied/a.json", '{"token":"hunter2"}')).route,
			secretOmitted: snapshot.verdict(text("server.key", "PRIVATE_KEY")).route,
			gone: snapshot.verdict(missing("src/a.ts")).route,
			binary: snapshot.verdict(binary("src/a.ts")).route,
			unreadable: snapshot.verdict(binary(".env.local")).route,
			answerAlone: snapshot.verdict(".env.local").route,
		};

		expect(routes).toEqual({
			omitted: "none",
			secretOmitted: "omit",
			gone: "none",
			binary: "none",
			unreadable: "none",
			answerAlone: "none",
		});
	});

	it("hands a provider the file as read, and keeps the index's hash of it", () => {
		const secret = text("deploy.yaml", SECRET);
		const configMap = text("deploy.yaml", CONFIG_MAP);
		const masked = parsed(snapshot.verdict(secret));
		const plain = parsed(snapshot.verdict(configMap));

		expect(masked.input).toBe(SECRET);
		expect(masked.hash).toBe(hashed(secret));
		expect(plain.input).toBe(CONFIG_MAP);
		expect(plain.hash).toBe(hashed(configMap));
	});

	it("draws digests from the text with each hidden value blanked", () => {
		const masked = parsed(snapshot.verdict(text("deploy.yaml", SECRET)));
		const plain = parsed(snapshot.verdict(text("deploy.yaml", CONFIG_MAP)));

		expect(masked.allowed).not.toContain("VALUE");
		expect(masked.allowed).toContain("token");
		expect(plain.allowed).toBe(CONFIG_MAP);
	});

	it("gives the index the keys a reader found, with the hash it keeps for them", () => {
		const read = text(".env.local", DOTENV);
		const verdict = snapshot.verdict(read);
		if (verdict.route !== "reader") throw new Error("expected the reader route");

		expect(verdict.declarations.map(({ name, valueStatus }) => [name, valueStatus])).toEqual([["TOKEN", "set"]]);
		expect(verdict.hash).toBe(hashed(read));
	});
});

describe("what a verdict lets back from a provider", () => {
	it("leaves a plain file's facts as they came", () => {
		const verdict = parsed(snapshot.verdict(text("deploy.yaml", CONFIG_MAP)));

		expect(verdict.facts(FACTS)).toBe(FACTS);
	});

	it("takes a hidden value out of a masked file's literals and diagnostics", () => {
		const verdict = parsed(snapshot.verdict(text("deploy.yaml", SECRET)));
		const filtered = verdict.facts(FACTS);

		expect(filtered.literals).toEqual([]);
		expect(JSON.stringify(filtered.diagnostics)).not.toContain("VALUE");
		expect(filtered.diagnostics).toHaveLength(1);
	});
});

describe("the words a verdict gives a failure", () => {
	const error = new Error("broke near hunter2");

	it("are the error's own for a plain module", () => {
		expect(words(snapshot.verdict(text("src/a.ts", "x")), error)).toBe("broke near hunter2");
		expect(words(snapshot.verdict("src/a.ts"), "not text")).toBe("not text");
	});

	it("carry none of the error for a module with anything hidden, and read alike", () => {
		const failures = [
			snapshot.verdict(text("deploy.yaml", SECRET)),
			snapshot.verdict(text(".env.local", DOTENV)),
			snapshot.verdict(text("denied/a.json", "{}")),
			snapshot.verdict(binary(".env.local")),
			snapshot.verdict(".env.local"),
		].map((verdict) => words(verdict, error));

		for (const failure of failures) expect(failure).not.toContain("hunter2");
		expect(new Set(failures).size).toBe(1);
	});

	it("tells the index when a module holds anything hidden", () => {
		const guarded = {
			plain: snapshot.verdict(text("src/a.ts", "x")).guarded,
			configMap: snapshot.verdict(text("deploy.yaml", CONFIG_MAP)).guarded,
			secret: snapshot.verdict(text("deploy.yaml", SECRET)).guarded,
			wholeFile: snapshot.verdict(text(".env.local", DOTENV)).guarded,
			omitted: snapshot.verdict("denied/a.json").guarded,
		};

		expect(guarded).toEqual({ plain: false, configMap: false, secret: true, wholeFile: true, omitted: true });
	});
});

describe("what the compiler refuses", () => {
	it("takes no failure a verdict did not word, and no route left unhandled", () => {
		const never = (verdict: ModuleVerdict) => {
			// @ts-expect-error failures require verdict wording
			const forged: StoredFailure = "details";
			// @ts-expect-error reader route lacks source text
			verdict.input;
			// @ts-expect-error provider route lacks declarations
			verdict.declarations;
			const handled = (): string => {
				switch (verdict.route) {
					case "none":
						return "none";
					case "omit":
						return "omit";
					case "reader":
						return "reader";
					case "provider":
						return "provider";
					default:
						return verdict satisfies never;
				}
			};
			const forgotten = (): string => {
				switch (verdict.route) {
					case "none":
						return "none";
					case "omit":
						return "omit";
					case "reader":
						return "reader";
					default:
						// @ts-expect-error verdict routes must be exhaustive
						return verdict satisfies never;
				}
			};
			return [forged, handled, forgotten];
		};

		expect(never).toBeInstanceOf(Function);
	});
});
