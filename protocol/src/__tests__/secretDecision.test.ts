import { describe, expect, it } from "bun:test";
import type { OffsetRange } from "../coordinates.js";
import type { SecretsConfig } from "../index.js";
import {
	applySecretMask,
	assessSecretText,
	decideDocument,
	decideSecretText,
	mayHideSecret,
	planSecretRule,
	type ReadableSecretRule,
	type SecretDecision,
	UNDECIDED,
	type Undecided,
} from "../secretDecision.js";
import {
	SecretBudgetError,
	type SecretFormat,
	type SecretNode,
	type SecretSyntax,
	verifySecretSyntax,
} from "../secretSyntax.js";
import { ruleFor as judgedRule } from "./fixtures/secrets/judge.js";
import { readToy, toyFormat } from "./fixtures/secrets/toyFormat.js";

////////////////////////////////
//  Fixtures

function ruleFor(path: string, config: SecretsConfig = {}, untracked = false): ReadableSecretRule {
	const rule = judgedRule(path, config, untracked);
	if (rule === null || ("whole" in rule && rule.whole === "omit")) throw new Error("no readable rule");
	return rule as ReadableSecretRule;
}

const KUBERNETES = ruleFor("deploy/all.yaml");

function assess(text: string, rule: ReadableSecretRule, undecided?: Undecided, format: SecretFormat = toyFormat) {
	return assessSecretText(format, rule, text, undecided);
}

function redacted(decision: SecretDecision) {
	if (decision.kind !== "redacted") throw new Error(`expected a redaction, got ${decision.kind}`);
	return decision;
}

function view(text: string, decision: SecretDecision): string {
	return decision.kind === "redacted" ? applySecretMask(text, decision.mask) : text;
}

function shownPaths(decision: SecretDecision): string[] {
	return decision.kind === "redacted" ? decision.shown.map((key) => key.path.join(".")) : [];
}

function spanOf(text: string, needle: string, from = 0): OffsetRange {
	const start = text.indexOf(needle, from);
	expect(start, needle).toBeGreaterThanOrEqual(0);
	return { start, end: start + needle.length };
}

function node(
	parent: number,
	names: string[],
	key: OffsetRange,
	value: OffsetRange,
	more: Partial<SecretNode> = {},
): SecretNode {
	return { parent, names, key, value, children: [], via: [], virtual: false, ...more };
}

/** A format that reads a syntax built by hand, with scalars looked up by node. */
function handBuilt(syntax: SecretSyntax, scalars: Record<number, string>, inert: RegExp = /[\s:{},]+/y): SecretFormat {
	return {
		...toyFormat,
		inert,
		read: () => syntax,
		scalar(_document, at) {
			const value = scalars[at];
			return value === undefined ? { kind: "uncertain", empty: false } : { kind: "decided", value, empty: false };
		},
	};
}

function random(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
		mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
		return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
	};
}

////////////////////////////////
//  Rule Planning

describe("secret rule planning", () => {
	it("keeps the final segment of each selecting key matcher", () => {
		const plan = planSecretRule(
			ruleFor("a.yaml", {
				"a.yaml": { "users.*.user": "omit", "kind=Secret": { data: "redact", "x.*": "redact" } },
			}),
		);
		expect([...plan.leaves].sort()).toEqual(["*", "data", "user"]);
		expect(plan.whole).toBe(false);
		expect(planSecretRule(ruleFor("credentials.json")).whole).toBe(true);
	});

	it("ignores matchers the config schema would reject", () => {
		const rule = { matchers: [{ "a..b": "redact", "@tracked": "redact", "a.b*": "redact", "x=y": "redact" }] };
		expect(planSecretRule(rule as never).leaves).toEqual([]);
	});
});

////////////////////////////////
//  Ported Planner Cases

describe("secret decision", () => {
	it("checks each Kubernetes document independently", () => {
		const text = [
			"kind: Secret",
			"data:",
			"  token: c2VjcmV0",
			"stringData:",
			"  password: topsecret",
			"---",
			"kind: Deployment",
			"data:",
			"  note: visible",
			"",
		].join("\n");
		const decision = assess(text, KUBERNETES);

		expect(shownPaths(decision)).toEqual(["data", "data.token", "stringData", "stringData.password"]);
		expect(redacted(decision).shown.every((key) => key.document === 0)).toBe(true);
		const masked = view(text, decision);
		expect(masked).not.toContain("c2VjcmV0");
		expect(masked).not.toContain("topsecret");
		expect(masked).toContain("visible");
		expect(masked).toContain("data:");
	});

	it("redacts data fields in Kubernetes lists", () => {
		const text = ["kind: List", "items:", "  -", "    kind: Secret", "    data:", "      token: hidden", ""].join(
			"\n",
		);
		const decision = assess(text, KUBERNETES);

		expect(shownPaths(decision)).toEqual(["items.0.data", "items.0.data.token"]);
		expect(view(text, decision)).not.toContain("hidden");
	});

	it("matches bare names at any depth and dotted paths from the root", () => {
		const text = ["password: top", "users:", "  -", "    user: alice", "    password: nested", ""].join("\n");
		const project = { "**/config.yaml": { password: "redact", "users.*.user": "omit" } } as const;
		const decision = assess(text, ruleFor("app/config.yaml", project));
		const masked = view(text, decision);

		expect(shownPaths(decision)).toEqual(["password", "users.0.password"]);
		expect(redacted(decision).omitted).toEqual([spanOf(text, "user: alice")]);
		expect(masked).not.toContain("top");
		expect(masked).not.toContain("nested");
		expect(masked).not.toContain("alice");
		expect(masked).toContain("password:");
	});

	it("uses star for array items and lets omit beat redact", () => {
		const text = [
			"users:",
			"  -",
			"    token: first",
			"    password: one",
			"  -",
			"    token: second",
			"    password: two",
			"",
		].join("\n");
		const project = {
			"**/config.yaml": { "users.*.token": "redact", password: "redact", "users.*.password": "omit" },
		} as const;
		const decision = assess(text, ruleFor("app/config.yaml", project));
		const masked = view(text, decision);

		expect(shownPaths(decision)).toEqual(["users.0.token", "users.1.token"]);
		expect(redacted(decision).omitted).toEqual([spanOf(text, "password: one"), spanOf(text, "password: two")]);
		for (const hidden of ["first", "second", "one", "two", "password"]) expect(masked).not.toContain(hidden);
		expect(masked).toContain("token:");
	});

	it("keeps key matchers under whole-file redaction", () => {
		const text = ["installed:", "  client_secret: secret", "  client_id: public", ""].join("\n");
		const project = {
			"**/credentials.json": "redact",
			"**/*.json": { "installed.client_secret": "omit" },
		} as const;
		const decision = assess(text, ruleFor("app/credentials.json", project));
		const masked = view(text, decision);

		expect(shownPaths(decision)).toEqual(["installed", "installed.client_id"]);
		expect(redacted(decision).omitted).toEqual([spanOf(text, "client_secret: secret")]);
		for (const hidden of ["secret", "public", "client_secret"]) expect(masked).not.toContain(hidden);
		expect(masked).toContain("client_id");
	});

	it("plans document checks with three states", () => {
		const secret = "kind: Secret\ndata:\n  token: hidden\n";
		const absent = "name: plain\ndata: visible\n";
		const unknown = "kind: ?templated\ndata: maybe\n";

		expect(shownPaths(assess(secret, KUBERNETES))).toEqual(["data", "data.token"]);
		expect(assess(absent, KUBERNETES)).toEqual({ kind: "plain" });
		expect(view(unknown, assess(unknown, KUBERNETES))).not.toContain("maybe");
		expect(assess(unknown, KUBERNETES, "withhold")).toEqual({ kind: "unreadable", reason: "undecided" });
	});

	it("masks a malformed secret and leaves a malformed plain file alone", () => {
		const secret = "data:\n  token: hidden\n!ar malformed\n";
		const plain = "name: package\n!ar malformed\n";

		expect(view(secret, assess(secret, KUBERNETES))).not.toContain("hidden");
		expect(shownPaths(assess(secret, KUBERNETES))).toEqual(["data", "data.token"]);
		expect(assess(plain, KUBERNETES)).toEqual({ kind: "plain" });
	});

	it("walks deep key trees without recursion", () => {
		const depth = 7000;
		const text = `${"x".repeat(depth)}password: hush${"x".repeat(depth)}`;
		const nodes: SecretNode[] = [
			node(-1, [], { start: 0, end: 0 }, { start: 0, end: text.length }, { children: [1] }),
		];
		for (let level = 0; level < depth; level++) {
			nodes.push(
				node(
					level,
					[`level${level}`],
					{ start: level, end: level },
					{ start: level, end: text.length - level },
					{
						children: [level + 2],
					},
				),
			);
		}
		nodes.push(node(depth, ["password"], spanOf(text, "password"), spanOf(text, "hush")));
		const format = handBuilt({ documents: [{ nodes, hazards: [] }] }, {}, /[\s\S]/y);
		const rule = ruleFor("config.yaml", { "**/config.yaml": { password: "redact" } });
		const decision = redacted(assess(text, rule, undefined, format));

		expect(decision.shown.map((key) => key.path.length)).toEqual([depth + 1]);
		expect(decision.mask).toEqual([spanOf(text, "hush")]);
	});
});

////////////////////////////////
//  Hazards And Pinning

describe("hazard consequences", () => {
	const text = (hazard: string) => `kind: Deployment\n${hazard}\ndata:\n  token: abc\n`;

	it("lets a reach of any unpin a check without a spelling", () => {
		const any = text("!a nothing spelled here");
		const spelledNowhere = text("!s nothing spelled here");
		const spelledKind = text("!s kind is spelled here");

		expect(view(any, assess(any, KUBERNETES))).not.toContain("abc");
		expect(assess(spelledNowhere, KUBERNETES)).toEqual({ kind: "plain" });
		expect(view(spelledKind, assess(spelledKind, KUBERNETES))).not.toContain("abc");
	});

	it("scopes a hazard to the routes it can change", () => {
		const root = "kind: Deployment\ndata:\n  token: abc\n!a junk\n";
		const nested = "meta:\n  !a junk\nkind: Deployment\ndata:\n  token: abc\n";
		const sibling = "meta:\n  kind: Deployment\n  !s elsewhere\nkind: Secret\ndata:\n  token: abc\n";

		expect(assess(root, KUBERNETES).kind).toBe("redacted");
		expect(assess(nested, KUBERNETES)).toEqual({ kind: "plain" });
		expect(shownPaths(assess(sibling, KUBERNETES))).toEqual(["data", "data.token"]);
	});

	it("is plain when an unpinned check has nothing to select", () => {
		const noted = "kind: Deployment\n!a junk\nnote: data\n";

		expect(mayHideSecret(toyFormat, KUBERNETES, noted)).toBe(true);
		expect(decideSecretText(toyFormat, KUBERNETES, noted)).toEqual({ kind: "plain" });
	});

	it("hides a contested hazard region that spells a selected name", () => {
		const contested = "kind: Secret\n!s data: leaked\nname: x\n";
		const decision = redacted(assess(contested, KUBERNETES));

		expect(decision.shown).toEqual([]);
		expect(view(contested, decision)).not.toContain("leaked");
		expect(view(contested, decision)).toContain("name: x");
	});

	it("leaves a hazard region visible when no selected name is spelled in it", () => {
		const text = "kind: Secret\n!s other: seen\ndata:\n  token: abc\n";
		const decision = redacted(assess(text, KUBERNETES));

		expect(view(text, decision)).toContain("other: seen");
		expect(view(text, decision)).not.toContain("abc");
	});

	it("drops the shown names a reshaping hazard puts in doubt", () => {
		const text = "kind: Secret\n!sr oops\ndata:\n  token: abc\n";
		const decision = redacted(assess(text, KUBERNETES));

		expect(decision.shown).toEqual([]);
		expect(view(text, decision)).not.toContain("abc");
	});

	it("drops the names after a reshaping hazard inside a value that is hidden anyway", () => {
		const text = "kind: Secret\ndata:\n  a: 1\n  !sr oops\n  b: 2\n";
		const decision = redacted(assess(text, KUBERNETES));

		expect(shownPaths(decision)).toEqual(["data", "data.a"]);
		expect(view(text, decision)).not.toContain("b: 2");
	});

	it("keeps the names before a reshaping hazard", () => {
		const text = "kind: Secret\ndata:\n  token: abc\n!sr oops\nlater: x\n";
		const decision = redacted(assess(text, KUBERNETES));

		expect(shownPaths(decision)).toEqual(["data", "data.token"]);
		expect(view(text, decision)).toContain("oops");
	});

	it("hides a reshaping hazard where a selected container may continue", () => {
		const project = { "a.yaml": { secrets: "redact" } } as const;
		const text = "secrets:\n  a: 1\n  !sr broken\nafter: 3\n";
		const decision = redacted(assess(text, ruleFor("a.yaml", project)));

		expect(view(text, decision)).not.toContain("broken");
		expect(view(text, decision)).toContain("after: 3");

		const closed = "secrets:\n  a: 1\n  !s broken\nafter: 3\n";
		expect(view(closed, assess(closed, ruleFor("a.yaml", project)))).toContain("broken");
	});

	it("takes disagreeing duplicate checks as unpinned and agreeing ones as pinned", () => {
		const disagree = "kind: Deployment\nkind: Secret\ndata:\n  token: abc\n";
		const agreeSecret = "kind: Secret\nkind: Secret\ndata:\n  token: abc\n";
		const agreeOther = "kind: Deployment\nkind: Deployment\ndata:\n  token: abc\n";

		expect(view(disagree, assess(disagree, KUBERNETES))).not.toContain("abc");
		expect(view(agreeSecret, assess(agreeSecret, KUBERNETES))).not.toContain("abc");
		expect(assess(agreeOther, KUBERNETES)).toEqual({ kind: "plain" });
	});

	it("reads a node supplied by a merge as unpinned", () => {
		const text = "src: {kind: Deployment}\ndata: abc\n";
		const kind = node(1, ["kind"], spanOf(text, "kind"), spanOf(text, "Deployment"));
		const supplied = node(0, ["kind"], kind.key, kind.value, { virtual: true });
		const root = (via: OffsetRange[], children: number[]) =>
			node(-1, [], { start: 0, end: 0 }, { start: 0, end: text.length }, { children, via });
		const src = node(0, ["src"], spanOf(text, "src"), spanOf(text, "{kind: Deployment}"), { children: [2] });
		const data = node(0, ["data"], spanOf(text, "data"), spanOf(text, "abc"));
		const scalars = { 2: "Deployment", 3: "abc", 4: "Deployment" };
		const withMerge = handBuilt(
			{ documents: [{ nodes: [root([src.value], [1, 3, 4]), src, kind, data, supplied], hazards: [] }] },
			scalars,
		);
		const without = handBuilt(
			{ documents: [{ nodes: [root([], [1, 3]), src, kind, data], hazards: [] }] },
			scalars,
		);

		expect(view(text, assess(text, KUBERNETES, undefined, withMerge))).not.toContain("abc");
		expect(assess(text, KUBERNETES, undefined, without)).toEqual({ kind: "plain" });
	});

	it("hides what an alias reads from, through the node's via spans", () => {
		const text = "base: &b {token: abc}\ndata: *b\n";
		const token = node(1, ["token"], spanOf(text, "token"), spanOf(text, "abc"));
		const base = node(0, ["base"], spanOf(text, "base"), spanOf(text, "{token: abc}"), { children: [2] });
		const alias = node(0, ["data"], spanOf(text, "data"), spanOf(text, "*b"), { children: [2], via: [base.value] });
		const root = node(-1, [], { start: 0, end: 0 }, { start: 0, end: text.length }, { children: [1, 3] });
		const format = handBuilt(
			{ documents: [{ nodes: [root, base, token, alias], hazards: [] }] },
			{},
			/(?:[\s:{},]+|&\w+)/y,
		);
		const decision = redacted(assess(text, ruleFor("a.yaml", { "a.yaml": { data: "redact" } }), undefined, format));

		expect(view(text, decision)).not.toContain("abc");
		expect(view(text, decision)).toContain("token");
		expect(shownPaths(decision)).toEqual(["base.token", "data"]);
	});

	it("hides what an alias inside a contested region reads", () => {
		const text = "base: &b abc\ndata *b\n";
		const region = spanOf(text, "data *b");
		const base = node(0, ["base"], spanOf(text, "base"), spanOf(text, "abc"));
		const alias = node(0, [], { start: region.end, end: region.end }, spanOf(text, "*b"), { via: [base.value] });
		const root = node(-1, [], { start: 0, end: 0 }, { start: 0, end: text.length }, { children: [1, 2] });
		const format = handBuilt(
			{
				documents: [
					{
						nodes: [root, base, alias],
						hazards: [{ span: region, within: 0, reach: "spelled", reshapes: false }],
					},
				],
			},
			{},
			/(?:[\s:{},]+|&\w+)/y,
		);
		const decision = redacted(assess(text, ruleFor("a.yaml", { "a.yaml": { data: "redact" } }), undefined, format));

		expect(view(text, decision)).not.toContain("abc");
		expect(view(text, decision)).toContain("base");
	});

	it("selects a node by any of its names", () => {
		const text = "on|true: hidden\nother: visible\n";
		const viaSource = assess(text, ruleFor("a.yaml", { "a.yaml": { on: "redact" } }));
		const viaNormalized = assess(text, ruleFor("a.yaml", { "a.yaml": { true: "redact" } }));

		for (const decision of [viaSource, viaNormalized]) {
			expect(view(text, decision)).not.toContain("hidden");
			expect(view(text, decision)).toContain("visible");
		}
		expect(shownPaths(viaNormalized)).toEqual(["on"]);
	});

	it("reports status from the format, never from a hidden value", () => {
		const text = "kind: Secret\ndata:\n  empty:\n  full: x\n";
		const decision = redacted(assess(text, KUBERNETES));

		expect(decision.shown.map((key) => [key.path.join("."), key.status])).toEqual([
			["data", "set"],
			["data.empty", "empty"],
			["data.full", "set"],
		]);
	});
});

////////////////////////////////
//  Text Assessment

describe("text assessment", () => {
	it("masks every unpinned reading by default and can withhold instead", () => {
		const text = "kind: ?templated\ndata: maybe\n";

		expect(UNDECIDED).toBe("mask");
		expect(assess(text, KUBERNETES).kind).toBe("redacted");
		expect(assess(text, KUBERNETES, "mask").kind).toBe("redacted");
		expect(assess(text, KUBERNETES, "withhold")).toEqual({ kind: "unreadable", reason: "undecided" });
	});

	it("withholds nothing when every check is pinned and no region is contested", () => {
		const text = "kind: Secret\ndata:\n  token: abc\n";
		expect(assess(text, KUBERNETES, "withhold").kind).toBe("redacted");
	});

	it("never hides less when the unpinned readings are taken together", () => {
		const secret = "kind: Secret\ndata: x\n";
		const other = "kind: Other\ndata: x\n";
		const unknown = "kind: ?x\ndata: x\n";
		const hidden = (text: string) => (assess(text, KUBERNETES).kind === "redacted" ? 1 : 0);

		expect(hidden(unknown)).toBeGreaterThanOrEqual(hidden(secret));
		expect(hidden(unknown)).toBeGreaterThanOrEqual(hidden(other));
	});

	it("reports a text the reader cannot afford as unreadable", () => {
		const exhausted: SecretFormat = {
			...toyFormat,
			read() {
				throw new SecretBudgetError("depth");
			},
		};
		expect(assess("kind: Secret\ndata: x\n", KUBERNETES, undefined, exhausted)).toEqual({
			kind: "unreadable",
			reason: "budget",
		});
		expect(assess("nothing spelled", KUBERNETES, undefined, exhausted)).toEqual({ kind: "plain" });
	});

	it("lets any other reader failure surface", () => {
		const broken: SecretFormat = {
			...toyFormat,
			read() {
				throw new TypeError("bug");
			},
		};
		expect(() => assess("kind: Secret\ndata: x\n", KUBERNETES, undefined, broken)).toThrow(TypeError);
	});

	it("keeps the mask disjoint, sorted and clear of every shown key", () => {
		const text = [
			"kind: Secret",
			"data:",
			"  token: abc",
			"  nested:",
			"    inner: def",
			"stringData:",
			"  password: ghi",
			"",
		].join("\n");
		const decision = redacted(assess(text, KUBERNETES));

		decision.mask.forEach((span, at) => {
			expect(span.end).toBeGreaterThan(span.start);
			if (at > 0) expect(span.start).toBeGreaterThan((decision.mask[at - 1] as OffsetRange).end);
		});
		for (const key of decision.shown) {
			expect(decision.mask.some((span) => span.start < key.key.end && key.key.start < span.end)).toBe(false);
			expect(text.slice(key.key.start, key.key.end)).toBe(String(key.path[key.path.length - 1]));
		}
		expect(view(text, decision)).toContain("inner");
		for (const hidden of ["abc", "def", "ghi"]) expect(view(text, decision)).not.toContain(hidden);
	});

	it("redacts a whole file even when nothing is readable in it", () => {
		const rule = ruleFor("services/.env.local", {}, true);
		const empty = redacted(assess("", rule));
		const comment = redacted(assess("# only words\n", rule));

		expect(empty.shown).toEqual([]);
		expect(comment.shown).toEqual([]);
		expect(comment.mask).toEqual([{ start: 0, end: "# only words\n".length }]);
	});

	it("proves a text plain when no selecting name is spelled in it", () => {
		const rng = random(7);
		const names = ["kind", "data", "stringData", "token", "note", "a", "b"];
		const values = ["Secret", "Deployment", "x", "?u"];
		const rules = [
			KUBERNETES,
			ruleFor("a.yaml", { "a.yaml": { token: "omit" } }),
			ruleFor("a.yaml", { "a.yaml": { "a.b": "redact", "kind=Deployment": { note: "redact" } } }),
			ruleFor("a.yaml", { "a.yaml": { "data.*": "redact" } }),
		];
		const pick = <T>(list: readonly T[]) => list[Math.floor(rng() * list.length)] as T;
		let skipped = 0;
		for (let round = 0; round < 400; round++) {
			const lines: string[] = [];
			for (let line = 0; line < 1 + Math.floor(rng() * 10); line++) {
				const indent = " ".repeat(2 * Math.floor(rng() * 3));
				const kind = rng();
				if (kind < 0.45) lines.push(`${indent}${pick(names)}: ${pick(values)}`);
				else if (kind < 0.7) lines.push(`${indent}${pick(names)}:`);
				else if (kind < 0.8) lines.push(`${indent}- ${pick(values)}`);
				else if (kind < 0.85) lines.push(`${indent}-`);
				else if (kind < 0.95)
					lines.push(`${indent}!${pick(["a", "s", "sr", "ar"])} ${pick(names)} ${pick(values)}`);
				else lines.push("---");
			}
			const text = `${lines.join("\n")}\n`;
			const rule = pick(rules);
			const full = decideSecretText(toyFormat, rule, text);
			if (!mayHideSecret(toyFormat, rule, text)) {
				skipped += 1;
				expect(full, text).toEqual({ kind: "plain" });
			}
			expect(assess(text, rule), text).toEqual(mayHideSecret(toyFormat, rule, text) ? full : { kind: "plain" });
		}
		expect(skipped).toBeGreaterThan(0);
	});
});

////////////////////////////////
//  Verified Syntax

describe("decideDocument", () => {
	it("takes only a syntax the verifier made", () => {
		const text = "kind: Secret\ndata: x\n";
		const plan = planSecretRule(KUBERNETES);
		const raw = { ...readToy(text), hazards: [[]], residual: 0 };

		// @ts-expect-error a raw object is not a VerifiedSyntax
		expect(() => decideDocument(toyFormat, plan, text, raw, 0)).toThrow(TypeError);

		const verified = verifySecretSyntax(toyFormat, text, readToy(text));
		expect(decideDocument(toyFormat, plan, text, verified, 0).selected).toBe(true);
	});
});
