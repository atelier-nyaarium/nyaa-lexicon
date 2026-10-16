// Portable secret evaluator for providers.
// Uses shared glob and matcher grammars.

import { expandSecretGlob, globToRegExp } from "./glob.js";
import { isMatcherMap } from "./secretMatchers.js";
import type {
	EffectiveSecretRule,
	SecretAnswer,
	SecretMatcherMap,
	SecretMatcherValue,
	SecretMode,
	SecretsConfig,
} from "./secrets.js";

////////////////////////////////
//  Interfaces & Types

/** Compiled rules and reader version. */
export interface SecretJudgeConfig {
	secrets: SecretsConfig;
	deny: readonly string[];
	syntax: number;
}

/** Workspace file evidence. */
export interface SecretJudgeEvidence {
	/** Tracked files; null means all untracked. */
	tracked: ReadonlySet<string> | null;
	aliasesByTarget: ReadonlyMap<string, readonly string[]>;
	targets: ReadonlyMap<string, string>;
	directoryLinks?: ReadonlyMap<string, string>;
}

/** Judge wire; `revision` hashes its fields. */
export interface SecretPolicyWire {
	revision: string;
	/** Sender's built-in rules hash. */
	builtIns: string;
	secrets: SecretsConfig;
	deny: string[];
	/** Reader version in non-plain stamps. */
	syntax: number;
	trackingKind: "tracked" | "untracked";
	/** Tracked paths whose rules change when untracked. */
	tracked: string[];
	aliases: Array<[target: string, aliases: string[]]>;
	targets: Array<[alias: string, target: string]>;
	directoryLinks?: Array<[alias: string, target: string]> | undefined;
}

export type SecretAccess = "open" | "closed" | "bytes";

interface CompiledGlob {
	glob: string;
	patterns: RegExp[];
	expanded: string[];
}

////////////////////////////////
//  Constants

const kubernetesSecret = {
	"kind=Secret": { data: "redact", stringData: "redact" },
	"kind=List": { items: { "*": { data: "redact", stringData: "redact" } } },
} satisfies SecretMatcherValue;

const BUILT_IN_SECRETS = {
	"**/.env*": { "@untracked": "redact" },
	"**/*.yaml": kubernetesSecret,
	"**/*.yml": kubernetesSecret,
	"**/*.json": kubernetesSecret,
	"**/credentials.json": "redact",
	"**/.credentials.json": "redact",
	"**/.docker/config.json": "redact",
	"**/.kube/config": "redact",
	"**/*.pem": "omit",
	"**/*.key": "omit",
	"**/*.p12": "omit",
	"**/*.pfx": "omit",
	"**/*.jks": "omit",
	"**/*.keystore": "omit",
	"**/*.ppk": "omit",
	"**/id_rsa": "omit",
	"**/id_dsa": "omit",
	"**/id_ecdsa": "omit",
	"**/id_ed25519": "omit",
	"**/credentials": "redact",
	"**/.git-credentials": "omit",
	"**/.netrc": "omit",
	"**/_netrc": "omit",
	"**/.npmrc": "redact",
	"**/.pypirc": "redact",
	"**/.pgpass": "omit",
	"**/.htpasswd": "omit",
} satisfies SecretsConfig;

const SHA256_ROUNDS = new Int32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
	0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
	0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
	0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
	0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
	0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
	0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
	0xc67178f2,
]);

/** Hex alphabet for hashes. */
const DIGEST_LENGTH = 32;

////////////////////////////////
//  Hash

const rotate = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits));

/** Pure UTF-8 sha256 matching `hashContent`. */
function digest(text: string): string {
	const bytes = new TextEncoder().encode(text);
	const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
	padded.set(bytes);
	padded[bytes.length] = 0x80;
	const view = new DataView(padded.buffer);
	view.setUint32(padded.length - 8, Math.floor(bytes.length / 0x20000000));
	view.setUint32(padded.length - 4, (bytes.length << 3) >>> 0);

	let h0 = 0x6a09e667 | 0;
	let h1 = 0xbb67ae85 | 0;
	let h2 = 0x3c6ef372 | 0;
	let h3 = 0xa54ff53a | 0;
	let h4 = 0x510e527f | 0;
	let h5 = 0x9b05688c | 0;
	let h6 = 0x1f83d9ab | 0;
	let h7 = 0x5be0cd19 | 0;
	const w = new Int32Array(64);
	for (let offset = 0; offset < padded.length; offset += 64) {
		for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
		for (let i = 16; i < 64; i++) {
			const x = w[i - 15] as number;
			const y = w[i - 2] as number;
			const s0 = rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3);
			const s1 = rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10);
			w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) | 0;
		}
		let a = h0;
		let b = h1;
		let c = h2;
		let d = h3;
		let e = h4;
		let f = h5;
		let g = h6;
		let h = h7;
		for (let i = 0; i < 64; i++) {
			const t1 =
				(h +
					(rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) +
					((e & f) ^ (~e & g)) +
					(SHA256_ROUNDS[i] as number) +
					(w[i] as number)) |
				0;
			const t2 = (rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
			h = g;
			g = f;
			f = e;
			e = (d + t1) | 0;
			d = c;
			c = b;
			b = a;
			a = (t1 + t2) | 0;
		}
		h0 = (h0 + a) | 0;
		h1 = (h1 + b) | 0;
		h2 = (h2 + c) | 0;
		h3 = (h3 + d) | 0;
		h4 = (h4 + e) | 0;
		h5 = (h5 + f) | 0;
		h6 = (h6 + g) | 0;
		h7 = (h7 + h) | 0;
	}
	return [h0, h1, h2, h3, h4, h5, h6, h7]
		.map((word) => (word >>> 0).toString(16).padStart(8, "0"))
		.join("")
		.slice(0, DIGEST_LENGTH);
}

////////////////////////////////
//  Rule Selection

function containsUntrackedCheck(value: SecretMatcherValue): boolean {
	if (typeof value === "string") return false;
	if ("@untracked" in value) return true;
	return Object.values(value).some((nested) => typeof nested !== "string" && containsUntrackedCheck(nested));
}

/** Built-ins ignore case; project and deny globs preserve it. */
function compileGlobs(config: SecretsConfig, flags?: "i"): CompiledGlob[] {
	return Object.keys(config).flatMap((glob) => {
		const expanded = expandSecretGlob(glob);
		if (expanded === null) return [];
		return [{ glob, expanded, patterns: expanded.map((pattern) => globToRegExp(pattern, flags)) }];
	});
}

function untrackedGlobs(config: SecretsConfig, compiled: readonly CompiledGlob[]): CompiledGlob[] {
	return compiled.filter(({ glob }) => containsUntrackedCheck(config[glob] as SecretMatcherValue));
}

const COMPILED_BUILT_IN_SECRETS = compileGlobs(BUILT_IN_SECRETS, "i");
const COMPILED_BUILT_IN_UNTRACKED = untrackedGlobs(BUILT_IN_SECRETS, COMPILED_BUILT_IN_SECRETS);
const BUILT_INS_HASH = digest(JSON.stringify(BUILT_IN_SECRETS));
const OMIT_RULE: EffectiveSecretRule = { whole: "omit" };

function matchingEntries(
	module: string,
	config: SecretsConfig,
	compiled: readonly CompiledGlob[],
): [string, SecretMatcherValue][] {
	return compiled.flatMap(({ glob, patterns }) => {
		const value = config[glob];
		return value !== undefined && patterns.some((pattern) => pattern.test(module)) ? [[glob, value]] : [];
	});
}

function matchesAny(module: string, compiled: readonly CompiledGlob[]): boolean {
	return compiled.some(({ patterns }) => patterns.some((pattern) => pattern.test(module)));
}

function stricterRule(rules: readonly (EffectiveSecretRule | null)[]): EffectiveSecretRule | null {
	if (rules.some((rule) => rule !== null && "whole" in rule && rule.whole === "omit")) return { whole: "omit" };
	const matchers = rules.flatMap((rule) => (rule !== null && "matchers" in rule ? [...rule.matchers] : []));
	const whole = rules.some((rule) => rule !== null && "whole" in rule && rule.whole === "redact");
	if (!whole && matchers.length === 0) return null;
	return whole ? { whole: "redact", matchers } : { matchers };
}

/** Compiled rules and deny globs. */
class CompiledRules {
	private readonly project: CompiledGlob[];
	private readonly projectUntracked: CompiledGlob[];
	private readonly denied: RegExp[];

	constructor(
		private readonly secrets: SecretsConfig,
		deny: readonly string[],
	) {
		this.project = compileGlobs(secrets);
		this.projectUntracked = untrackedGlobs(secrets, this.project);
		this.denied = deny.map((glob) => globToRegExp(glob));
	}

	isDenied(module: string): boolean {
		return this.denied.some((pattern) => pattern.test(module));
	}

	/** Matching project rules replace built-ins. */
	ruleFor(module: string, untracked: boolean): EffectiveSecretRule | null {
		const projectMatches = matchingEntries(module, this.secrets, this.project);
		const entries =
			projectMatches.length > 0
				? projectMatches
				: matchingEntries(module, BUILT_IN_SECRETS, COMPILED_BUILT_IN_SECRETS);
		const wholeModes: SecretMode[] = [];
		const matchers: SecretMatcherMap[] = [];
		for (const [, value] of entries) {
			if (typeof value === "string") {
				wholeModes.push(value);
				continue;
			}
			const untrackedRule = value["@untracked"];
			if (untracked && typeof untrackedRule === "string") wholeModes.push(untrackedRule);
			if (untracked && isMatcherMap(untrackedRule)) matchers.push(untrackedRule as SecretMatcherMap);
			const rest = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "@untracked"));
			if (Object.keys(rest).length > 0) matchers.push(rest as SecretMatcherMap);
		}
		if (wholeModes.includes("omit")) return { whole: "omit" };
		const whole = wholeModes.length > 0 ? "redact" : undefined;
		if (whole === "redact" && matchers.length === 0) return { whole };
		return matchers.length === 0 && whole === undefined
			? null
			: { ...(whole === undefined ? {} : { whole }), matchers };
	}

	/** Whether tracking changes a file's rule. */
	dependsOnTracking(module: string): boolean {
		return matchesAny(module, COMPILED_BUILT_IN_UNTRACKED) || matchesAny(module, this.projectUntracked);
	}

	/** Candidate globs for whole-file rules across tracking states. */
	discoveryGlobs(): string[] {
		const globs = new Set<string>();
		const sources: Array<[SecretsConfig, readonly CompiledGlob[]]> = [
			[BUILT_IN_SECRETS, COMPILED_BUILT_IN_SECRETS],
			[this.secrets, this.project],
		];
		for (const [config, compiled] of sources) {
			for (const { glob, expanded } of compiled) {
				const value = config[glob];
				if (
					value === "redact" ||
					value === "omit" ||
					(typeof value !== "string" &&
						(value?.["@untracked"] === "redact" || value?.["@untracked"] === "omit"))
				)
					for (const pattern of expanded) globs.add(pattern);
			}
		}
		return [...globs];
	}
}

////////////////////////////////
//  Files And Links

/** File, target, and reverse links. */
function candidatesOf(
	module: string,
	targets: ReadonlyMap<string, string>,
	aliasesByTarget: ReadonlyMap<string, readonly string[]>,
	directoryLinks: ReadonlyMap<string, string>,
): string[] {
	const found = new Set<string>([module]);
	const pending = [module];
	for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
		const add = (candidate: string) => {
			if (!found.has(candidate)) {
				found.add(candidate);
				pending.push(candidate);
			}
		};
		const target = targets.get(current);
		if (target !== undefined) add(target);
		for (const alias of aliasesByTarget.get(current) ?? []) add(alias);
		for (const [alias, directory] of directoryLinks) {
			if (current === alias) add(directory);
			else if (current.startsWith(`${alias}/`)) add(`${directory}${current.slice(alias.length)}`);
			if (current === directory) add(alias);
			else if (current.startsWith(`${directory}/`)) add(`${alias}${current.slice(directory.length)}`);
		}
	}
	return [...found];
}

function trackingSensitive(
	rules: CompiledRules,
	module: string,
	targets: ReadonlyMap<string, string>,
	aliasesByTarget: ReadonlyMap<string, readonly string[]>,
	directoryLinks: ReadonlyMap<string, string>,
): boolean {
	return candidatesOf(module, targets, aliasesByTarget, directoryLinks).some((candidate) =>
		rules.dependsOnTracking(candidate),
	);
}

function differsByTracking(
	rules: CompiledRules,
	module: string,
	targets: ReadonlyMap<string, string>,
	aliasesByTarget: ReadonlyMap<string, readonly string[]>,
	directoryLinks: ReadonlyMap<string, string>,
): boolean {
	return candidatesOf(module, targets, aliasesByTarget, directoryLinks).some(
		(candidate) =>
			JSON.stringify(rules.ruleFor(candidate, false)) !== JSON.stringify(rules.ruleFor(candidate, true)),
	);
}

////////////////////////////////
//  Wire

/** Revision fields in hash order. */
function revisionOf(wire: Omit<SecretPolicyWire, "revision">): string {
	return digest(
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
}

function sealed(wire: Omit<SecretPolicyWire, "revision">): SecretPolicyWire {
	return { revision: revisionOf(wire), ...wire };
}

function byKey(left: readonly [string, unknown], right: readonly [string, unknown]): number {
	return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
}

////////////////////////////////
//  Judge

/** Same wire gives the same module answer. */
export class SecretJudge {
	private readonly trackedSet: ReadonlySet<string>;
	private readonly targets: ReadonlyMap<string, string>;
	private readonly aliasesByTarget: ReadonlyMap<string, readonly string[]>;
	private readonly directoryLinks: ReadonlyMap<string, string>;
	private readonly answers = new Map<string, SecretAnswer>();
	private readonly stamps = new Map<string, string>();

	private constructor(
		readonly wire: SecretPolicyWire,
		private readonly rules: CompiledRules,
	) {
		if (wire.builtIns !== BUILT_INS_HASH)
			throw new Error("secret policy wire was judged with other built-in rules");
		if (wire.revision !== revisionOf(wire)) throw new Error("secret policy wire does not match its revision");
		this.trackedSet = new Set(wire.tracked);
		this.targets = new Map(wire.targets);
		this.aliasesByTarget = new Map(wire.aliases);
		this.directoryLinks = new Map(wire.directoryLinks ?? []);
	}

	/** Rejects wires with invalid revisions. */
	static from(wire: SecretPolicyWire): SecretJudge {
		return new SecretJudge(wire, new CompiledRules(wire.secrets, wire.deny));
	}

	/** Judge built from daemon evidence. */
	static fromEvidence(config: SecretJudgeConfig, evidence: SecretJudgeEvidence): SecretJudge {
		const rules = new CompiledRules(config.secrets, config.deny);
		const { targets, aliasesByTarget } = evidence;
		const directoryLinks = evidence.directoryLinks ?? new Map();
		const tracked =
			evidence.tracked === null
				? []
				: [...evidence.tracked]
						.filter(
							(module) =>
								trackingSensitive(rules, module, targets, aliasesByTarget, directoryLinks) &&
								differsByTracking(rules, module, targets, aliasesByTarget, directoryLinks),
						)
						.sort();
		const wire = sealed({
			builtIns: BUILT_INS_HASH,
			secrets: config.secrets,
			deny: [...config.deny],
			syntax: config.syntax,
			trackingKind: evidence.tracked === null ? "untracked" : "tracked",
			tracked,
			aliases: [...aliasesByTarget]
				.map(([target, aliases]): [string, string[]] => [target, [...aliases]])
				.sort(byKey),
			targets: [...targets].map(([alias, target]): [string, string] => [alias, target]).sort(byKey),
			...(directoryLinks.size === 0
				? {}
				: {
						directoryLinks: [...directoryLinks]
							.map(([alias, target]): [string, string] => [alias, target])
							.sort(byKey),
					}),
		});
		return new SecretJudge(wire, rules);
	}

	get revision(): string {
		return this.wire.revision;
	}

	answer(module: string): SecretAnswer {
		const cached = this.answers.get(module);
		if (cached !== undefined) return cached;
		const answer = this.judge(module);
		this.answers.set(module, answer);
		return answer;
	}

	access(module: string): SecretAccess {
		return accessOf(this.answer(module));
	}

	answerThrough(module: string, real: string): SecretAnswer {
		const key = `\0${JSON.stringify([module, real])}`;
		const cached = this.answers.get(key);
		if (cached !== undefined) return cached;
		const candidates = new Set([
			module,
			...candidatesOf(real, this.targets, this.aliasesByTarget, this.directoryLinks),
		]);
		const answer = this.judge(module, [...candidates]);
		this.answers.set(key, answer);
		return answer;
	}

	accessThrough(module: string, real: string): SecretAccess {
		return accessOf(this.answerThrough(module, real));
	}

	/** Candidate globs only narrow searches. */
	discoveryGlobs(): string[] {
		return this.rules.discoveryGlobs();
	}

	private judge(
		module: string,
		candidates = candidatesOf(module, this.targets, this.aliasesByTarget, this.directoryLinks),
	): SecretAnswer {
		if (candidates.some((candidate) => this.rules.isDenied(candidate)))
			return { kind: "omit", by: "deny", stamp: this.stampOf(OMIT_RULE) };
		const rule = stricterRule(
			candidates.map((candidate) => this.rules.ruleFor(candidate, this.untracked(candidate))),
		);
		if (rule === null) return { kind: "plain", stamp: null };
		if (rule.whole === "omit") return { kind: "omit", by: "secret", stamp: this.stampOf(OMIT_RULE) };
		const stamp = this.stampOf(rule);
		if ("whole" in rule && rule.whole === "redact") return { kind: "wholeRedact", rule, stamp };
		return { kind: "matchers", rule, stamp };
	}

	private untracked(module: string): boolean {
		return this.wire.trackingKind !== "tracked" || !this.trackedSet.has(module);
	}

	/** Rule and reader changes invalidate stamps. */
	private stampOf(rule: EffectiveSecretRule): string {
		const text = JSON.stringify({ syntax: this.wire.syntax, rule });
		const known = this.stamps.get(text);
		if (known !== undefined) return known;
		const stamp = digest(text);
		this.stamps.set(text, stamp);
		return stamp;
	}
}

function accessOf(answer: SecretAnswer): SecretAccess {
	if (answer.kind === "plain") return "open";
	if (answer.kind === "omit") return "closed";
	return "bytes";
}
