import { describe, expect, it } from "bun:test";
import { CONFORMANCE_POLICY } from "../conformance/policy.js";
import { hashContent } from "../hash.js";
import { SecretJudge, type SecretPolicyWire } from "../secretJudge.js";
import type { SecretsConfig } from "../secrets.js";
import { judgeOf } from "./fixtures/secrets/judge.js";

////////////////////////////////
//  Fixtures

/** Wire revision hashes its contents. */
function reseal(wire: Omit<SecretPolicyWire, "revision">): SecretPolicyWire {
	const revision = hashContent(
		JSON.stringify({
			builtIns: wire.builtIns,
			secrets: wire.secrets,
			deny: wire.deny,
			syntax: wire.syntax,
			trackingKind: wire.trackingKind,
			tracked: wire.tracked,
			aliases: wire.aliases,
			targets: wire.targets,
			directoryLinks: wire.directoryLinks ?? [],
		}),
	);
	return { revision, ...wire };
}

const PROJECT = {
	"**/config.json": { "@untracked": { password: "redact" } },
	"**/*.FOO": "redact",
	"./**/*.{cfg,ini}": { "kind=Secret": { data: "omit" } },
} as const satisfies SecretsConfig;

const LINKED = judgeOf(PROJECT, {
	deny: ["**/.git/**", "private/**"],
	tracked: [".env", "app/config.json", "src/index.ts"],
	aliasesByTarget: new Map([
		["home/.kube/config", ["kubelink/config", "cfg/app.json"]],
		[".env.local", ["link/.env.local"]],
	]),
	targets: new Map([
		["kubelink/config", "home/.kube/config"],
		["cfg/app.json", "home/.kube/config"],
		["link/.env.local", ".env.local"],
	]),
});

const PROBES = [
	"src/index.ts",
	".env",
	".env.local",
	"link/.env.local",
	"app/config.json",
	"other/config.json",
	"deploy/all.yaml",
	"home/.kube/config",
	"kubelink/config",
	"cfg/app.json",
	"private/x.ts",
	"keys/Server.PEM",
	"vault.FOO",
	"vault.foo",
	"dir/app.ini",
];

////////////////////////////////
//  Tests

describe("what the judge answers", () => {
	it("redacts every untracked dotenv file and leaves tracked ones alone", () => {
		const untracked = judgeOf();
		const tracked = judgeOf({}, { tracked: ["project/.env.local", "project/.env.example"] });

		expect(untracked.answer("project/.env.local")).toMatchObject({ kind: "wholeRedact" });
		expect(untracked.answer("project/.ENV.LOCAL")).toMatchObject({ kind: "wholeRedact" });
		expect(untracked.answer("project/CREDENTIALS.JSON")).toMatchObject({ kind: "wholeRedact" });
		expect(tracked.answer("project/.env.local")).toEqual({ kind: "plain", stamp: null });
		expect(tracked.answer("project/.env.example")).toEqual({ kind: "plain", stamp: null });
		expect(tracked.answer("project/.env.new")).toMatchObject({ kind: "wholeRedact" });
	});

	it("reads every file as untracked when git could not say", () => {
		expect(judgeOf().wire).toMatchObject({ trackingKind: "untracked", tracked: [] });
		expect(judgeOf({}, { tracked: [] }).wire).toMatchObject({ trackingKind: "tracked", tracked: [] });
	});

	it("keeps project glob matching case-sensitive and built-ins case-insensitive", () => {
		const judge = judgeOf({ "**/*.FOO": "redact" });

		expect(judge.answer("private.foo")).toEqual({ kind: "plain", stamp: null });
		expect(judge.answer("private.FOO")).toMatchObject({ kind: "wholeRedact" });
		expect(judge.answer("src/Credentials.json")).toMatchObject({ kind: "wholeRedact" });
	});

	it("omits structureless built-ins and redacts key formats", () => {
		const judge = judgeOf();
		const omitted = [
			"server.pem",
			"server.key",
			"server.p12",
			"server.pfx",
			"server.jks",
			"server.keystore",
			"server.ppk",
			"id_rsa",
			"id_dsa",
			"id_ecdsa",
			"id_ed25519",
			".git-credentials",
			".netrc",
			"_netrc",
			".pgpass",
			".htpasswd",
		];
		const redacted = [
			"credentials.json",
			".credentials.json",
			".docker/config.json",
			".kube/config",
			"credentials",
			"home/.aws/credentials",
			".npmrc",
			".pypirc",
		];

		for (const module of omitted)
			expect(judge.answer(module), module).toMatchObject({ kind: "omit", by: "secret" });
		for (const module of redacted) expect(judge.answer(module), module).toMatchObject({ kind: "wholeRedact" });
		expect(judge.answer(".env.local")).toMatchObject({ kind: "wholeRedact" });
	});

	it("normalizes secret glob prefixes and expands alternatives", () => {
		const judge = judgeOf({ "./**/*.{yaml,yml}": "redact" });

		expect(judge.answer("app/config.yaml")).toMatchObject({ kind: "wholeRedact" });
		expect(judge.answer("app/config.yml")).toMatchObject({ kind: "wholeRedact" });
		expect(judge.discoveryGlobs()).toContain("**/*.yaml");
		expect(judge.discoveryGlobs()).toContain("**/*.yml");
	});

	it("lets a matching empty project entry replace a built-in", () => {
		expect(judgeOf({ "**/.env*": {} }).answer("project/.env.local")).toEqual({ kind: "plain", stamp: null });
	});

	it("combines a file with what it links to", () => {
		const project = { "**/config.json": "redact", "**/credentials.json": "omit" } as const;
		const linked = judgeOf(project, {
			tracked: [],
			aliasesByTarget: new Map([["src/config.json", ["src/credentials.json"]]]),
			targets: new Map([["src/credentials.json", "src/config.json"]]),
		});

		expect(judgeOf(project).answer("src/plain.ts")).toEqual({ kind: "plain", stamp: null });
		expect(linked.answer("src/config.json")).toMatchObject({ kind: "omit", by: "secret" });
		expect(linked.answer("src/credentials.json")).toMatchObject({ kind: "omit", by: "secret" });
	});

	it("routes descendants through directory links", () => {
		const judge = judgeOf(
			{},
			{
				tracked: [".kube/config"],
				directoryLinks: new Map([["kubelink", ".kube"]]),
			},
		);

		expect(judge.answer("kubelink/config").kind).toBe("wholeRedact");
	});

	it("keeps matchers when a rule only names keys", () => {
		expect(
			judgeOf({ "**/*.json": { password: "omit" } }, { tracked: ["src/config.json"] }).answer("src/config.json"),
		).toMatchObject({
			kind: "matchers",
			rule: { matchers: [{ password: "omit" }] },
		});
	});

	it("denies a file whose link is denied, whatever the rules say", () => {
		const judge = judgeOf({ "**/credentials.json": "redact" }, { deny: ["**/credentials.json"] });

		expect(judge.answer("src/credentials.json")).toMatchObject({ kind: "omit", by: "deny" });
		expect(LINKED.answer("private/x.ts")).toMatchObject({ kind: "omit", by: "deny" });
	});

	it("stamps by rule, sharing one stamp across files under the same rule", () => {
		expect(LINKED.answer("deploy/all.yaml").stamp).toBe(judgeOf().answer("other/all.yaml").stamp);
		expect(LINKED.answer("private/x.ts").stamp).toBe(LINKED.answer("private/y.ts").stamp);
		expect(judgeOf().answer("src/a.ts").stamp).toBeNull();
	});

	it("stamps with the same sha256 the rest of the index uses", () => {
		for (const length of [0, 1, 20, 30, 31, 32, 33, 60, 61, 62, 63, 64, 120, 121, 122, 127, 128, 200, 400]) {
			const key = `é😀${"k".repeat(length)}`;
			const answer = judgeOf({ "**/a.cfg": { [key]: "redact" } }).answer("x/a.cfg");

			expect(answer.kind).toBe("matchers");
			if (answer.kind === "matchers")
				expect(answer.stamp).toBe(hashContent(JSON.stringify({ syntax: 1, rule: answer.rule })));
		}
	});

	it("moves every non-plain stamp with the reader version and leaves plain files unstamped", () => {
		const files = { tracked: ["src/index.ts"] };
		const probes = ["deploy/all.yaml", ".env.local", "vault.FOO", "private/x.ts", "src/index.ts"];
		const before = judgeOf(PROJECT, { ...files, deny: ["private/**"] }, 1);
		const after = judgeOf(PROJECT, { ...files, deny: ["private/**"] }, 2);

		for (const probe of probes) {
			const [was, now] = [before.answer(probe), after.answer(probe)];

			expect(now.kind, probe).toBe(was.kind);
			if (was.stamp === null) expect(now.stamp, probe).toBeNull();
			else expect(now.stamp, probe).not.toBe(was.stamp);
		}
		expect(before.answer("src/index.ts").stamp).toBeNull();
		expect(before.answer("private/x.ts").kind).toBe("omit");
	});
});

describe("provider path access", () => {
	it("distinguishes open, closed and byte-judged paths", () => {
		const judge = judgeOf(
			{
				"**/private.json": "omit",
				"**/.env.local": { "@untracked": "omit" },
				"**/settings.yaml": { password: "omit" },
				"./**/*.{json,yaml}": "omit",
			},
			{ deny: ["**/.git/**"] },
		);

		expect(judge.access(".git/config")).toBe("closed");
		expect(judge.access("private.json")).toBe("closed");
		expect(judge.access(".env.local")).toBe("closed");
		expect(judge.access("settings.yaml")).toBe("closed");
		expect(judge.access("app.cfg")).toBe("open");
	});

	it("uses tracking evidence when judging dotenv paths", () => {
		const judge = judgeOf({}, { deny: [], tracked: [".env"] });

		expect(judge.access(".env")).toBe("open");
		expect(judge.access(".env.local")).toBe("bytes");
		expect(judge.access("src/a.ts")).toBe("open");
		expect(judge.access("credentials.json")).toBe("bytes");
	});

	it("finds whole-file candidates by glob whatever git tracks", () => {
		const globs = judgeOf({ "**/*.FOO": "redact", "private.foo": "omit" }).discoveryGlobs();

		expect(globs).toContain("**/.env*");
		expect(globs).toContain("**/*.pem");
		expect(globs).toContain("**/*.key");
		expect(globs).toContain("**/*.FOO");
		expect(globs).toContain("private.foo");
		expect(globs).not.toContain("**/*.json");
	});
});

describe("the policy as data", () => {
	it("keeps the conformance wire valid", () => {
		expect(SecretJudge.from(CONFORMANCE_POLICY).wire).toEqual(CONFORMANCE_POLICY);
	});

	it("holds only tracked files whose answer tracking could change", () => {
		const { wire } = LINKED;

		expect(wire.tracked).toEqual([".env", "app/config.json"]);
		expect(wire.trackingKind).toBe("tracked");
	});

	it("answers the same from a wire that crossed JSON", () => {
		const received = SecretJudge.from(JSON.parse(JSON.stringify(LINKED.wire)));

		expect(received.revision).toBe(LINKED.revision);
		for (const probe of PROBES) expect(received.answer(probe), probe).toEqual(LINKED.answer(probe));
	});

	it("hashes its fields in a fixed order", () => {
		expect(LINKED.wire).toEqual(reseal(LINKED.wire));
	});

	it("keeps one revision however the evidence was enumerated", () => {
		const tracked = [".env", "app/config.json"];
		const forward = judgeOf(PROJECT, {
			tracked,
			aliasesByTarget: new Map([
				["a", ["x"]],
				["b", ["y"]],
			]),
			targets: new Map([
				["x", "a"],
				["y", "b"],
			]),
		});
		const reversed = judgeOf(PROJECT, {
			tracked: [...tracked].reverse(),
			aliasesByTarget: new Map([
				["b", ["y"]],
				["a", ["x"]],
			]),
			targets: new Map([
				["y", "b"],
				["x", "a"],
			]),
		});

		expect(reversed.revision).toBe(forward.revision);
	});

	it("moves with every input", () => {
		const base = judgeOf(PROJECT, { tracked: [".env"], deny: ["x/**"] });
		const moved = [
			judgeOf({ ...PROJECT, "**/more": "omit" }, { tracked: [".env"], deny: ["x/**"] }),
			judgeOf(PROJECT, { tracked: [".env"], deny: ["y/**"] }),
			judgeOf(PROJECT, { deny: ["x/**"] }),
			judgeOf(PROJECT, { tracked: [], deny: ["x/**"] }),
			judgeOf(PROJECT, { tracked: [".env", ".env.example"], deny: ["x/**"] }),
			judgeOf(PROJECT, { tracked: [".env"], deny: ["x/**"], targets: new Map([["l", "t"]]) }),
			judgeOf(PROJECT, { tracked: [".env"], deny: ["x/**"], aliasesByTarget: new Map([["t", ["l"]]]) }),
			judgeOf(PROJECT, { tracked: [".env"], deny: ["x/**"], directoryLinks: new Map([["link", "target"]]) }),
			judgeOf(PROJECT, { tracked: [".env"], deny: ["x/**"] }, 2),
		];

		expect(new Set([base, ...moved].map((judge) => judge.revision)).size).toBe(moved.length + 1);
	});

	it("refuses a wire whose contents do not hash to its revision", () => {
		const { wire } = LINKED;
		const tampered: SecretPolicyWire[] = [
			{ ...wire, secrets: { ...wire.secrets, "**/extra": "omit" } },
			{ ...wire, deny: [...wire.deny, "other/**"] },
			{ ...wire, syntax: wire.syntax + 1 },
			{ ...wire, trackingKind: "untracked" },
			{ ...wire, tracked: [...wire.tracked, "src/index.ts"] },
			{ ...wire, aliases: [...wire.aliases, ["a", ["b"]]] },
			{ ...wire, targets: [...wire.targets, ["a", "b"]] },
			{ ...wire, revision: hashContent("another policy") },
		];

		expect(() => SecretJudge.from(wire)).not.toThrow();
		for (const wireOf of tampered) expect(() => SecretJudge.from(wireOf)).toThrow();
	});

	it("refuses a wire judged with other built-in rules, even when it is whole", () => {
		const { revision: _revision, ...contents } = LINKED.wire;

		expect(() => SecretJudge.from(reseal({ ...contents, builtIns: hashContent("other built-ins") }))).toThrow();
		expect(() => SecretJudge.from(reseal(contents))).not.toThrow();
	});
});
