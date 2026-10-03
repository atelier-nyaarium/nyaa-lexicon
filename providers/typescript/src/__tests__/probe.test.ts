import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashContent, parseSymbolId } from "@nyaa-lexicon/protocol";
import { TypeScriptProvider } from "../main.js";
import { harness } from "./harness.js";

////////////////////////////////
//  Helpers

const roots: string[] = [];

function workspace(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-typescript-probe-"));
	roots.push(root);
	for (const [module, text] of Object.entries(files)) {
		const full = path.join(root, module);
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, text);
	}
	return root;
}

const FILES = {
	"src/a.ts": "export function one() {}\n",
	"src/b.ts": 'import { one } from "./a";\none();\n',
};

/** `a` trades `one` for `two`, a new `c` declares `three`, and `b` uses both. */
const PROBE = {
	"src/a.ts": "export function two() {}\n",
	"src/c.ts": "export function three() {}\n",
	"src/b.ts":
		'import { two } from "./a";\nimport { three } from "./c";\nexport function seen() {}\ntwo();\nthree();\n',
};

function admitted() {
	const provider = harness();
	provider.initialize(workspace(FILES));
	const held = () =>
		Object.entries(FILES).map(([module, text]) =>
			provider.parseFile({ module, contentHash: hashContent(text), text }),
		);
	return { provider, held };
}

function proposed(files: Record<string, string>) {
	return Object.entries(files).map(([module, text]) => ({ module, contentHash: hashContent(text), text }));
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("batch probe", () => {
	it("reads every proposed text as one program, answers the modules asked, and lands each specifier", () => {
		const { provider, held } = admitted();
		const before = held();
		const answer = provider.provider.probeBatch({ files: proposed(PROBE), answer: ["src/b.ts", "src/a.ts"] });
		if (answer.status !== "ready") throw new Error(`the probe was unsupported: ${answer.detail}`);

		const facts = new Map(answer.facts.map((one) => [one.module, one]));
		expect([...facts.keys()]).toEqual(["src/b.ts", "src/a.ts"]);
		expect(facts.get("src/b.ts")?.contentHash).toBe(hashContent(PROBE["src/b.ts"]));
		expect(facts.get("src/b.ts")?.declarations.map((declaration) => declaration.name)).toEqual(["seen"]);
		const bound = facts.get("src/b.ts")?.references.map((reference) => {
			const binding = reference.binding;
			return binding.status === "bound"
				? `${reference.name} ${parseSymbolId(binding.symbolId)?.module}`
				: reference.name;
		});
		expect(bound).toEqual(["two src/a.ts", "three src/c.ts"]);
		expect(
			answer.landings.map(({ module, specifier, resolution }) => [
				module,
				specifier,
				resolution.status === "resolved" && resolution.landing.kind === "module"
					? resolution.landing.module
					: null,
			]),
		).toEqual([
			["src/b.ts", "./a", "src/a.ts"],
			["src/b.ts", "./c", "src/c.ts"],
		]);

		// What the provider holds is unchanged.
		expect(held()).toEqual(before);
		expect(provider.resolveImport({ fromModule: "src/b.ts", specifier: "./c" })).toMatchObject({
			status: "unresolved",
		});
		provider.shutdown();
	});

	it("answers an unproposed module at its admitted text, read against the proposals", () => {
		const { provider, held } = admitted();
		held();
		const answer = provider.provider.probeBatch({
			files: proposed({ "src/a.ts": "export function other() {}\n" }),
			answer: ["src/b.ts"],
		});
		if (answer.status !== "ready") throw new Error("the probe was unsupported");
		expect(answer.facts.map((one) => [one.module, one.contentHash])).toEqual([
			["src/b.ts", hashContent(FILES["src/b.ts"])],
		]);
		// `one` left the proposed `a`.
		expect(answer.facts[0]?.references.map((reference) => reference.binding.status)).toEqual(["unbound"]);
		provider.shutdown();
	});

	it("keeps none of a probe's reads in the store's memos", () => {
		const { provider, held } = admitted();
		held();
		const store = provider.provider.store;
		const shared = store.memo.bind(store);
		const keys: string[] = [];
		store.memo = (key, compute) => {
			keys.push(key);
			return shared(key, compute);
		};
		const answer = provider.provider.probeBatch({ files: proposed(PROBE), answer: ["src/b.ts", "src/a.ts"] });
		expect(answer.status).toBe("ready");
		expect(keys).toEqual([]);
		// An admitted read still memoizes there.
		held();
		expect(keys.length).toBeGreaterThan(0);
		provider.shutdown();
	});

	it("is unsupported before a project is discovered", () => {
		const answer = new TypeScriptProvider().probeBatch({ files: proposed(PROBE), answer: ["src/b.ts"] });
		expect(answer.status).toBe("unsupported");
	});
});
