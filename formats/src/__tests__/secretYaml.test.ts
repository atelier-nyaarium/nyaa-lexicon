import { describe, expect, it } from "bun:test";
import { applySecretMask, assessSecretText, type ReadableSecretRule } from "@nyaa-lexicon/protocol/secretDecision";
import type { ScalarReading, SecretSyntaxDocument } from "@nyaa-lexicon/protocol/secretSyntax";
import { ruleFor } from "../../../protocol/src/__tests__/fixtures/secrets/judge.js";
import { yamlFormat } from "../secret/index.js";
import { contractViolations } from "./secretConformance.js";

////////////////////////////////
//  Fixtures

const KUBERNETES = ruleFor("deploy/all.yaml", {}, false) as ReadableSecretRule;
const TOKEN = { matchers: [{ token: "redact" }] } as unknown as ReadableSecretRule;
const DATA = { matchers: [{ data: "redact" }] } as unknown as ReadableSecretRule;

function documents(text: string): readonly SecretSyntaxDocument[] {
	return yamlFormat.read(text).documents;
}

function nodeAt(document: SecretSyntaxDocument | undefined, path: string): number {
	let current = 0;
	for (const part of path.split(".")) {
		const next = document?.nodes[current]?.children.find((child) => document.nodes[child]?.names.includes(part));
		if (next === undefined) return -1;
		current = next;
	}
	return current;
}

function scalarAt(document: SecretSyntaxDocument | undefined, path: string): ScalarReading | null {
	const at = nodeAt(document, path);
	return document === undefined || at < 0 ? null : yamlFormat.scalar(document, at);
}

function decide(text: string, matchers: Record<string, unknown>) {
	return assessSecretText(yamlFormat, { matchers: [matchers] } as unknown as ReadableSecretRule, text);
}

function view(text: string, decision: ReturnType<typeof decide>): string {
	return decision.kind === "redacted" ? applySecretMask(text, decision.mask) : text;
}

////////////////////////////////
//  Tests

describe("YAML secret reader", () => {
	it("reads every document of a stream with its own checks", () => {
		const text =
			'root:\n  missing:\n  explicit: null\n  empty: ""\n  block: |\n    one\n    two\nitems:\n  - first\n  - 2\n---\nkind: Deployment\n';
		const [first, second] = documents(text);
		const decision = decide(text, { root: "redact" });

		expect(documents(text)).toHaveLength(2);
		expect(
			decision.kind === "redacted" ? decision.shown.map((key) => [key.path.join("."), key.status]) : [],
		).toEqual([
			["root", "set"],
			["root.missing", "empty"],
			["root.explicit", "empty"],
			["root.empty", "empty"],
			["root.block", "set"],
		]);
		expect(scalarAt(first, "root.block")).toEqual({ kind: "decided", value: "one\ntwo\n", empty: false });
		expect(scalarAt(first, "items.0")).toEqual({ kind: "decided", value: "first", empty: false });
		expect(scalarAt(first, "items.1")).toEqual({ kind: "decided", value: "2", empty: false });
		expect(scalarAt(first, "kind")).toBeNull();
		expect(scalarAt(second, "kind")).toEqual({ kind: "decided", value: "Deployment", empty: false });
	});

	it("numbers empty documents like the provider does", () => {
		expect(documents("")).toHaveLength(0);
		expect(documents("# only a comment\n")).toHaveLength(0);
		expect(documents("---\n---\na: 1\n")).toHaveLength(2);
	});

	it("resolves an alias to its scalar and shares the children of an anchor", () => {
		const text = "kindValue: &secretKind Secret\nkind: *secretKind\nbase: &b\n  token: x\ncopy: *b\n";
		const [document] = documents(text);

		expect(scalarAt(document, "kind")).toEqual({ kind: "decided", value: "Secret", empty: false });
		const copy = document?.nodes[nodeAt(document, "copy")];
		const base = document?.nodes[nodeAt(document, "base")];
		expect(copy?.children).toBe(base?.children);
		expect(copy?.via).toEqual(base === undefined ? [] : [base.value]);
		expect(documents(text)[0]?.hazards).toEqual([]);
	});

	it("keeps a merge key as a node and supplies its keys as virtual children", () => {
		const text = "base: &defaults\n  existing: name\nconfig:\n  <<: *defaults\n  own: x\n";
		const [document] = documents(text);
		const config = document?.nodes[nodeAt(document, "config")];
		const children = (config?.children ?? []).map((child) => document?.nodes[child]);

		expect(children.map((child) => [child?.names[0], child?.virtual])).toEqual([
			["<<", false],
			["own", false],
			["existing", true],
		]);
		const base = document?.nodes[nodeAt(document, "base")];
		expect(config?.via).toEqual(base === undefined ? [] : [base.value]);
	});

	it("leaves a kind supplied by a root merge unpinned", () => {
		const text = "metadata: &kind\n  kind: Secret\n<<: *kind\ndata:\n  token: FIXTURE_ROOT\n";
		const other = "metadata: &kind\n  kind: Deployment\n<<: *kind\ndata:\n  token: FIXTURE_ROOT\n";

		expect(view(text, assessSecretText(yamlFormat, KUBERNETES, text))).not.toContain("FIXTURE_ROOT");
		expect(view(other, assessSecretText(yamlFormat, KUBERNETES, other))).not.toContain("FIXTURE_ROOT");
	});

	it("reads duplicate keys as separate nodes", () => {
		const text = "kind: Deployment\nkind: Secret\n";
		const [document] = documents(text);

		expect(document?.nodes.filter((node) => node.names.includes("kind"))).toHaveLength(2);
	});

	it("names a key by the provider's spelling, YAML 1.1's and the source's", () => {
		const text = 'on: enabled\n010: v\n"d\\x61ta": 1\nyes: 2\n~: 3\n';
		const [document] = documents(text);

		expect(document?.nodes.slice(1).map((node) => node.names)).toEqual([
			["on", "true"],
			["10", "8", "010"],
			["data", "d\\x61ta"],
			["yes", "true"],
			["null", "~"],
		]);
	});

	it("hands the value of a complex key to whatever name the key spells", () => {
		const text = "on: enabled\nkind: Secret\ndata:\n  ? [one, two]\n  : hidden\n";
		const [document] = documents(text);
		const key = text.indexOf("[one, two]");

		expect(document?.hazards).toEqual([
			{
				span: { start: key, end: text.indexOf("hidden") + "hidden".length },
				within: nodeAt(document, "data"),
				reach: "spelled",
				reshapes: false,
			},
		]);
		expect(document?.nodes.some((node) => node.names.length === 0)).toBe(true);
	});

	it("hides what a selected value reads through an alias, wherever the anchor sits", () => {
		const cases: Array<[string, string, ReadableSecretRule]> = [
			[
				"FIXTURE_KEY_MAP",
				"kind: Secret\n? note: &value FIXTURE_KEY_MAP\n: x\nstringData:\n  token: *value\n",
				KUBERNETES,
			],
			["FIXTURE_KEY_SEQ", "? [&value FIXTURE_KEY_SEQ]\n: x\ntoken: *value\n", TOKEN],
			["FIXTURE_CHAIN", "v: &v FIXTURE_CHAIN\nt: &t {x: *v}\n? &k [*t]\n: y\ntoken: *k\n", TOKEN],
			["FIXTURE_SELF", "root: &root\n  note: FIXTURE_SELF\n  token: *root\n", TOKEN],
			["FIXTURE_NAME", "kind: Secret\nbase: &name FIXTURE_NAME\nstringData:\n  *name : value\n", KUBERNETES],
			["FIXTURE_NAMED", "&name token: 1\n*name : FIXTURE_NAMED\n", TOKEN],
			["FIXTURE_READ", "v: &v FIXTURE_READ\nk: &b data\n*b : *v\n", DATA],
		];
		const shown = cases.filter(([secret, text, rule]) =>
			view(text, assessSecretText(yamlFormat, rule, text)).includes(secret),
		);

		expect(shown.map(([secret]) => secret)).toEqual([]);
	});

	it("lets an alias stand for any name", () => {
		const text = "a: &k token\n*k : x\n";
		const alias = { start: text.indexOf("*k"), end: text.length };

		expect(yamlFormat.mayName(text, alias, ["data"])).toBe(true);
		expect(yamlFormat.mayName("a: &k token\n*j : x\n", { start: 12, end: 20 }, ["data"])).toBe(false);
		expect(yamlFormat.mayName("cron: '* * * * *'\n", { start: 0, end: 18 }, ["data"])).toBe(false);
	});

	it("accounts for bytes the composer leaves out of an explicit key", () => {
		const text = '? "token":[data, x]\n: FIXTURE_OTHER\nkind: Secret\n';
		const document = documents(text)[0];

		expect(contractViolations(yamlFormat, [{ name: "explicit key", text }])).toEqual([]);
		expect(
			document?.hazards.some(
				(hazard) => hazard.span.start <= text.indexOf("[data") && hazard.span.end >= text.indexOf("x]"),
			),
		).toBe(true);
	});

	it("reshapes the document at an error", () => {
		const [document] = documents("a:\n  - b\n c: d\nkind: x\n");

		expect(document?.hazards.some((hazard) => hazard.reshapes && hazard.within === 0)).toBe(true);
	});

	it("holds a tree together when error recovery leaves a child outside its container", () => {
		const text = "kind: List\nitems:\n  - kind: Secret\n    > token: FIXTURE_LIST\n    data:\n";
		const [document] = documents(text);
		const nodes = document?.nodes ?? [];
		const outside = nodes.filter((node, at) => {
			const parent = nodes[node.parent];
			return (
				at > 0 &&
				!node.virtual &&
				parent !== undefined &&
				Math.max(node.key.end, node.value.end) > parent.value.end
			);
		});

		expect(nodes.length).toBeGreaterThan(3);
		expect(outside).toEqual([]);
		expect(contractViolations(yamlFormat, [{ name: "recovered", text }])).toEqual([]);
	});

	it("reads a stream of 1600 documents in linear time", () => {
		const stream = (count: number) => "kind: Secret\ndata:\n  token: abc\n---\n".repeat(count);
		const time = (text: string) => {
			const started = performance.now();
			assessSecretText(yamlFormat, KUBERNETES, text);
			return performance.now() - started;
		};
		time(stream(200));
		const small = Math.min(time(stream(800)), time(stream(800)));
		const large = Math.min(time(stream(3200)), time(stream(3200)));

		expect(documents(stream(1600))).toHaveLength(1601);
		expect(large / small).toBeLessThan(9);
	});

	it("reads nesting past the budget as unreadable", () => {
		const deep = `${"[".repeat(100_000)}${"]".repeat(100_000)}`;
		const whole = ruleFor("home/.kube/config", {}, false) as ReadableSecretRule;

		expect(assessSecretText(yamlFormat, whole, deep)).toEqual({ kind: "unreadable", reason: "budget" });
	});

	it("shares the children of an anchor instead of expanding aliases", () => {
		const levels = Array.from({ length: 40 }, (_, at) =>
			at === 0
				? "l0: &a0 [x, x, x, x, x, x, x, x, x]"
				: `l${at}: &a${at} [${Array(9)
						.fill(`*a${at - 1}`)
						.join(", ")}]`,
		);
		const text = `${levels.join("\n")}\nkind: Secret\ndata: *a39\n`;
		const started = performance.now();
		const decision = assessSecretText(yamlFormat, KUBERNETES, text);

		expect(performance.now() - started).toBeLessThan(2000);
		expect(decision.kind).toBe("redacted");
	});

	it("merges each key once, and never the merge key itself", () => {
		const text = [
			"a: &a",
			"  k: v",
			"b: &b",
			"  <<: [*a, *a, *a]",
			"c: &c",
			"  <<: [*b, *b, *b]",
			"d:",
			"  <<: [*c, *c, *c]",
			"",
		].join("\n");
		const [document] = documents(text);
		const merged = (document?.nodes[nodeAt(document, "d")]?.children ?? []).map((child) => document?.nodes[child]);

		expect(merged.filter((child) => child?.virtual).map((child) => child?.names[0])).toEqual(["k"]);
	});

	it("matches YAML files by extension and kube configs by name", () => {
		for (const path of ["a.yaml", "a/B.YML", "home/.kube/config"])
			expect(yamlFormat.matches(path), path).toBe(true);
		for (const path of ["a.yaml.bak", "config", "a/kube/config"])
			expect(yamlFormat.matches(path), path).toBe(false);
	});
});
