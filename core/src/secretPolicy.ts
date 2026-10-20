import { randomUUID } from "node:crypto";
import { SECRET_SYNTAX_VERSION, secretFormatFor } from "@nyaa-lexicon/formats/secret";
import {
	coordinatesOf,
	hashBytes,
	hashContent,
	type SecretAnswer,
	type SecretsConfig,
	SecretsConfigSchema,
} from "@nyaa-lexicon/protocol";
import { assessSecretText } from "@nyaa-lexicon/protocol/secretDecision";
import { type SecretAccess, SecretJudge, type SecretPolicyWire } from "@nyaa-lexicon/protocol/secretJudge";
import type { Clock, TimerHandle } from "./clock.js";
import { systemClock } from "./clock.js";
import {
	CONFIG_FILE,
	denyGlobs,
	type GitRunner,
	type LinkEvidenceFileSystem,
	type ScopeConfig,
	type ScopeConfigRead,
	scopeFor,
} from "./fileScope.js";
import { type EvidenceKind, type EvidenceView, PolicyEvidence } from "./policyEvidence.js";
import type { MethodResponse } from "./providerPort.js";
import { type Refusal, secretFile } from "./refusals.js";
import {
	displaySecretText,
	maskedView,
	maskForDecision,
	maskSecretText,
	protectSecretFacts,
	redactedText,
	type SecretDeclaration,
	type SecretMask,
	secretDeclarations,
	wholeFileMask,
} from "./secrets.js";
import {
	type AllowedView,
	readSource,
	type SealedRead,
	type SealedText,
	sourceReadBytes,
	type TextView,
	unseal,
} from "./sourceRead.js";
import type { IndexStore } from "./store.js";

type ParseFacts = MethodResponse<"parseFile">;
const snapshotOwner = Symbol("SecretPolicy");
const POLICY_AUDIT_MS = 60 * 60 * 1000;

export type PolicyAffected = "all" | { modules: ReadonlySet<string>; prefixes: readonly string[] };

function affectedContains(affected: PolicyAffected, module: string): boolean {
	return (
		affected === "all" ||
		affected.modules.has(module) ||
		affected.prefixes.some((prefix) => prefix === "" || module.startsWith(`${prefix}/`))
	);
}

export interface SecretPolicyConfig {
	secrets: SecretsConfig;
	deny: readonly string[];
}

export type SecretVerdict =
	| { kind: "plain" }
	| { kind: "omit" }
	| { kind: "withheld" }
	| { kind: "keys"; declarations: readonly SecretDeclaration[]; mask: SecretMask; allowed: string }
	| { kind: "masked"; declarations: readonly SecretDeclaration[]; mask: SecretMask; allowed: string };

/** Policy route for module bytes. */
export type AdmittedAs = SecretVerdict["kind"];

declare const admissionBrand: unique symbol;

/** Branded module admission; only snapshots mint it. */
export interface SecretAdmission {
	readonly module: string;
	readonly stamp: string | null;
	readonly as: AdmittedAs;
	readonly [admissionBrand]: true;
}

declare const journalAdmissionBrand: unique symbol;

export interface StoredAdmission {
	readonly module: string;
	readonly hash: string;
	readonly stamp: string | null;
}

/** Branded journal admission. */
export interface JournalAdmission extends StoredAdmission {
	readonly [journalAdmissionBrand]: true;
}

/** Journal admission carrying bytes. */
export interface AdmittedBytes extends JournalAdmission {
	readonly bytes: Uint8Array;
}

/** Result of journal admission. */
export type JournalAdmissionResult<T> = { kind: "admitted"; value: T } | { kind: "withheld"; reason: Refusal };

/** Disk bytes or a withheld safe-view hash. */
export type JournalBytesResult =
	| { kind: "admitted"; value: AdmittedBytes }
	| { kind: "withheld"; reason: Refusal; view: JournalAdmission };

declare const failureBrand: unique symbol;

/** Policy-approved error text; verdicts mint it. */
export type StoredFailure = string & { readonly [failureBrand]: true };

interface VerdictBase {
	readonly admission: SecretAdmission;
	/** Whether policy hides any module text. */
	readonly guarded: boolean;
	/** Plain errors stay specific; guarded errors are generic. */
	failure(error: unknown): StoredFailure;
}

/** No provider route for omitted, unreadable, or fully hidden modules. */
export interface UnparsedVerdict extends VerdictBase {
	readonly route: "none";
}

/** Indexes whole-file keys without provider parsing. */
interface OmittedVerdict extends VerdictBase {
	readonly route: "omit";
	readonly hash: string;
}

/** The index extracts keys; providers do not parse. */
export interface ReaderVerdict extends VerdictBase {
	readonly route: "reader";
	readonly hash: string;
	readonly declarations: readonly SecretDeclaration[];
}

/** The provider parses this module. */
export interface ProviderVerdict extends VerdictBase {
	readonly route: "provider";
	readonly hash: string;
	/** Text sent to the provider. */
	readonly input: string;
	/** Blanked text available to digests. */
	readonly allowed: string;
	/** Provider facts after secret filtering. */
	facts(facts: ParseFacts): ParseFacts;
}

/** Byte handling route and policy admission. */
export type ModuleVerdict = UnparsedVerdict | OmittedVerdict | ReaderVerdict | ProviderVerdict;

type RedactedVerdict = Extract<SecretVerdict, { kind: "keys" | "masked" }>;

const SECRET_DETAILS_WITHHELD = "secret file; details withheld";

const PLAIN_VERDICT: SecretVerdict = { kind: "plain" };
const OMIT_VERDICT: SecretVerdict = { kind: "omit" };
const WITHHELD_VERDICT: SecretVerdict = { kind: "withheld" };

function ownFailure(error: unknown): StoredFailure {
	return (error instanceof Error ? error.message : String(error)) as StoredFailure;
}

function withheldFailure(): StoredFailure {
	return SECRET_DETAILS_WITHHELD as StoredFailure;
}

/** Hash of visible text, hidden spans, and shown keys. */
function maskedHash(verdict: RedactedVerdict): string {
	const declarations = verdict.declarations.map(({ symbolId, valueStatus, selectionRange }) => ({
		symbolId,
		valueStatus,
		selectionRange,
	}));
	const coordinates = coordinatesOf(verdict.allowed);
	const spans = verdict.mask.spans.map((span) => {
		const offsets = coordinates.offsetsForRange(span);
		return offsets === undefined ? null : [offsets.start, offsets.end];
	});
	return hashContent(
		JSON.stringify({ visible: redactedText(verdict.allowed, verdict.mask.spans), spans, declarations }),
	);
}

/** Filters hidden facts, restores shown keys, and masks diagnostics. */
function maskedFacts(facts: ParseFacts, verdict: RedactedVerdict): ParseFacts {
	const kept = protectSecretFacts(facts, verdict.mask);
	const present = new Set(
		kept.declarations.map((declaration) => JSON.stringify(declaration.selectionRange ?? declaration.range)),
	);
	const additions = verdict.declarations.filter(
		(declaration) => !present.has(JSON.stringify(declaration.selectionRange ?? declaration.range)),
	);
	return {
		...kept,
		declarations: [...kept.declarations, ...additions],
		diagnostics: kept.diagnostics.map(({ severity }) => ({ severity, message: SECRET_DETAILS_WITHHELD })),
	};
}

/** No text means key-path rules hide nothing. */
function admittedAsWithoutText(answer: SecretAnswer): AdmittedAs {
	switch (answer.kind) {
		case "plain":
		case "matchers":
			return "plain";
		case "omit":
			return "omit";
		case "wholeRedact":
			return "keys";
	}
}

/** Withholds text when hidden spans cannot be blanked. */
function redactedVerdict(
	kind: "keys" | "masked",
	text: string,
	mask: SecretMask,
	declarations: readonly SecretDeclaration[],
): SecretVerdict {
	const allowed = maskSecretText(text, mask.spans);
	return allowed === null ? WITHHELD_VERDICT : { kind, declarations, mask, allowed };
}

function expectedReal(
	module: string,
	targets: ReadonlyMap<string, string>,
	directoryLinks: ReadonlyMap<string, string>,
): string {
	let current = module;
	const seen = new Set<string>();
	for (;;) {
		if (seen.has(current)) return current;
		seen.add(current);
		const exact = targets.get(current);
		if (exact !== undefined) {
			current = exact;
			continue;
		}
		const prefix = [...directoryLinks]
			.filter(([alias]) => current.startsWith(`${alias}/`))
			.sort(([left], [right]) => right.length - left.length)[0];
		if (prefix === undefined) return current;
		current = `${prefix[1]}${current.slice(prefix[0].length)}`;
	}
}

export class SecretPolicySnapshot {
	readonly revision: string;
	private readonly judge: SecretJudge;
	private readonly discoveryJudge: SecretJudge;
	private readonly targets: ReadonlyMap<string, string>;
	private readonly directoryLinks: ReadonlyMap<string, string>;
	private readonly assessments = new WeakMap<SealedRead, SecretVerdict>();
	private readonly markLinksStale: () => void;
	private readonly inherited: { snapshot: SecretPolicySnapshot; affected: PolicyAffected } | null;

	constructor(
		view: EvidenceView,
		owner: typeof snapshotOwner,
		markLinksStale: () => void = () => {},
		inherited: { snapshot: SecretPolicySnapshot; affected: PolicyAffected } | null = null,
	) {
		if (owner !== snapshotOwner) throw new Error("secret policy owns snapshots");
		this.markLinksStale = markLinksStale;
		this.inherited = inherited;
		this.targets = view.collected.targets;
		this.directoryLinks = view.collected.directoryLinks;
		this.judge = SecretJudge.fromEvidence(
			{
				secrets: view.config.secrets ?? {},
				deny: denyGlobs(view.config),
				syntax: SECRET_SYNTAX_VERSION,
			},
			{
				tracked: view.collected.tracking.kind === "tracked" ? view.collected.tracking.files : null,
				aliasesByTarget: view.collected.aliasesByTarget,
				targets: view.collected.targets,
				directoryLinks: view.collected.directoryLinks,
			},
		);
		this.discoveryJudge = SecretJudge.fromEvidence(
			{
				secrets: view.config.secrets ?? {},
				deny: denyGlobs(view.config),
				syntax: SECRET_SYNTAX_VERSION,
			},
			{ tracked: null, aliasesByTarget: new Map(), targets: new Map() },
		);
		this.revision = hashContent(
			JSON.stringify({
				judge: this.judge.revision,
				evidence: view.revision,
			}),
		);
	}

	discovers(module: string): boolean {
		const answer = this.discoveryJudge.answer(module);
		return answer.kind === "wholeRedact" || (answer.kind === "omit" && answer.by === "secret");
	}

	/** Policy judgment in wire form. */
	get wire(): SecretPolicyWire {
		return this.judge.wire;
	}

	answer(module: string): SecretAnswer {
		if (this.inherited !== null && !affectedContains(this.inherited.affected, module))
			return this.inherited.snapshot.answer(module);
		return this.judge.answer(module);
	}

	access(module: string): SecretAccess {
		if (this.inherited !== null && !affectedContains(this.inherited.affected, module))
			return this.inherited.snapshot.access(module);
		return this.judge.access(module);
	}

	/** Policy-visible view and index hash. */
	view(read: SealedText, display?: boolean): TextView;
	view(read: SealedRead, display?: boolean): AllowedView;
	view(read: SealedRead, display = false): AllowedView {
		const verdict = this.assess(read);
		switch (verdict.kind) {
			case "plain": {
				const raw = unseal(read);
				if (raw.kind !== "text") return raw;
				return { kind: "plain", text: raw.text, hash: hashContent(raw.text), lossless: raw.lossless };
			}
			case "omit":
			case "withheld":
				return {
					kind: "refused",
					hash: hashContent(JSON.stringify({ module: read.module, verdict: verdict.kind })),
				};
			case "keys":
			case "masked": {
				const raw = display ? unseal(read) : undefined;
				const shown = raw?.kind === "text" ? displaySecretText(raw.text, verdict.mask) : undefined;
				return maskedView(verdict.allowed, maskedHash(verdict), verdict.mask, shown);
			}
		}
	}

	/** Read verdict, or policy answer without text. */
	verdict(subject: string | SealedRead): ModuleVerdict {
		const admission = this.admission(subject);
		const guarded = admission.as !== "plain";
		const base = { admission, guarded, failure: guarded ? withheldFailure : ownFailure };
		if (typeof subject === "string") return { ...base, route: "none" };
		const assessed = this.assess(subject);
		switch (assessed.kind) {
			case "plain": {
				const view = this.view(subject);
				if (view.kind !== "plain") return { ...base, route: "none" };
				return {
					...base,
					route: "provider",
					hash: view.hash,
					input: view.text,
					allowed: view.text,
					facts: (facts) => facts,
				};
			}
			case "keys":
				return { ...base, route: "reader", hash: maskedHash(assessed), declarations: assessed.declarations };
			case "masked": {
				const raw = unseal(subject);
				if (raw.kind !== "text") return { ...base, route: "none" };
				return {
					...base,
					route: "provider",
					hash: maskedHash(assessed),
					input: raw.text,
					allowed: assessed.allowed,
					facts: (facts) => maskedFacts(facts, assessed),
				};
			}
			case "omit": {
				const answer = this.answerForRead(subject);
				if (answer.kind !== "omit" || answer.by === "deny") return { ...base, route: "none" };
				const view = this.view(subject);
				return view.kind === "refused"
					? { ...base, route: "omit", hash: view.hash }
					: { ...base, route: "none" };
			}
			case "withheld":
				return { ...base, route: "none" };
		}
	}

	/** Module admission from its read or policy answer. */
	admission(subject: string | SealedRead): SecretAdmission {
		const module = typeof subject === "string" ? subject : subject.module;
		const answer = typeof subject === "string" ? this.answer(module) : this.answerForRead(subject);
		const as = typeof subject === "string" ? admittedAsWithoutText(answer) : this.assess(subject).kind;
		return { module, stamp: answer.stamp, as } as SecretAdmission;
	}

	private assess(read: SealedRead): SecretVerdict {
		const cached = this.assessments.get(read);
		if (cached !== undefined) return cached;
		const verdict = this.assessUncached(read);
		this.assessments.set(read, verdict);
		return verdict;
	}

	private assessUncached(read: SealedRead): SecretVerdict {
		const { module } = read;
		const answer = this.answerForRead(read);
		if (answer.kind === "plain") return PLAIN_VERDICT;
		if (answer.kind === "omit") return OMIT_VERDICT;
		const raw = unseal(read);
		if (answer.kind === "matchers" && raw.kind === "missing") return PLAIN_VERDICT;
		if (raw.kind !== "text") return WITHHELD_VERDICT;
		const wholeFile = answer.kind === "wholeRedact";
		const format = secretFormatFor(read.real ?? module);
		if (format === null) {
			const mask = wholeFile ? wholeFileMask(raw.text) : null;
			return mask === null ? WITHHELD_VERDICT : redactedVerdict("keys", raw.text, mask, []);
		}
		const decision = assessSecretText(format, answer.rule, raw.text);
		if (decision.kind === "plain") return PLAIN_VERDICT;
		if (decision.kind === "unreadable") return WITHHELD_VERDICT;
		const mask = maskForDecision(raw.text, decision, wholeFile);
		if (mask === null) return WITHHELD_VERDICT;
		return redactedVerdict(
			wholeFile ? "keys" : "masked",
			raw.text,
			mask,
			secretDeclarations(format.id, module, mask.shown, decision.documents),
		);
	}

	private answerForRead(read: SealedRead): SecretAnswer {
		const actual = read.real;
		if (actual === undefined) return this.answer(read.module);
		const expected = expectedReal(read.module, this.targets, this.directoryLinks);
		if (actual === expected) return this.answer(read.module);
		this.markLinksStale();
		return this.judge.answerThrough(read.module, actual);
	}
}

export interface PolicyChange {
	revision: string;
	moved: boolean;
	affected: PolicyAffected;
	admissionMoved: boolean;
	subscriptionsMoved: boolean;
}

export type PolicyTrigger =
	| { kind: "startup" }
	| { kind: "audit" }
	| { kind: "events"; modules: readonly string[]; changed?: readonly string[]; evidence?: readonly EvidenceKind[] };

export interface PolicyJournal {
	policyChanged(change: PolicyChange): void;
}

export interface PolicyProviders {
	policyChanged(change: PolicyChange): void;
}

export interface PolicyIndex {
	installScope(scope: import("./fileScope.js").FileScope, change: PolicyChange): void;
	auditPolicy?(): Promise<void>;
}

function affectedBetween(before: EvidenceView | null, after: EvidenceView): PolicyAffected {
	if (before === null) return "all";
	const priorInputs = new Map(before.inputs.map((input) => [input.kind, input.digest]));
	const nextInputs = new Map(after.inputs.map((input) => [input.kind, input.digest]));
	if (priorInputs.get("config") !== nextInputs.get("config")) return "all";
	const modules = new Set<string>();
	const prefixes = new Set<string>();
	const addRelated = (module: string) => {
		const pending = [module];
		const seen = new Set<string>();
		for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
			if (seen.has(current)) continue;
			seen.add(current);
			modules.add(current);
			for (const collected of [before.collected, after.collected]) {
				const target = collected.targets.get(current);
				if (target !== undefined) pending.push(target);
				pending.push(...(collected.aliasesByTarget.get(current) ?? []));
				for (const [alias, destination] of collected.targets) if (destination === current) pending.push(alias);
				for (const [alias, destination] of collected.directoryLinks) {
					if (current === alias || current.startsWith(`${alias}/`))
						pending.push(`${destination}${current.slice(alias.length)}`);
					if (current === destination || current.startsWith(`${destination}/`))
						pending.push(`${alias}${current.slice(destination.length)}`);
				}
			}
		}
	};
	const priorRepositories = new Map(
		before.collected.repositories.map((repository) => [repository.prefix, repository]),
	);
	const nextRepositories = new Map(after.collected.repositories.map((repository) => [repository.prefix, repository]));
	for (const prefix of new Set([...priorRepositories.keys(), ...nextRepositories.keys()])) {
		const previous = priorRepositories.get(prefix);
		const next = nextRepositories.get(prefix);
		if (
			previous === undefined ||
			next === undefined ||
			previous.state !== next.state ||
			previous.gitDir !== next.gitDir ||
			previous.indexPath !== next.indexPath
		)
			prefixes.add(prefix);
		const tracked = new Set([...(previous?.tracked ?? []), ...(next?.tracked ?? [])]);
		for (const module of tracked)
			if (previous?.tracked.has(module) !== next?.tracked.has(module)) addRelated(module);
		const nested = new Set([...(previous?.nested ?? []), ...(next?.nested ?? [])]);
		for (const module of nested)
			if (previous?.nested.has(module) !== next?.nested.has(module)) prefixes.add(module);
		const gitlinks = new Set([...(previous?.gitlinks ?? []), ...(next?.gitlinks ?? [])]);
		for (const module of gitlinks)
			if (previous?.gitlinks.has(module) !== next?.gitlinks.has(module)) prefixes.add(module);
		const untracked = new Set([...(previous?.untracked ?? []), ...(next?.untracked ?? [])]);
		for (const module of untracked)
			if (previous?.untracked.has(module) !== next?.untracked.has(module)) addRelated(module);
		const discovered = new Set([...(previous?.discovered ?? []), ...(next?.discovered ?? [])]);
		for (const module of discovered)
			if (previous?.discovered.has(module) !== next?.discovered.has(module)) addRelated(module);
		const ignored = new Set([...(previous?.ignored.files ?? []), ...(next?.ignored.files ?? [])]);
		for (const module of ignored)
			if (previous?.ignored.files.has(module) !== next?.ignored.files.has(module)) addRelated(module);
		const ignoredFolders = new Set([...(previous?.ignored.folders ?? []), ...(next?.ignored.folders ?? [])]);
		for (const folder of ignoredFolders)
			if (previous?.ignored.folders.has(folder) !== next?.ignored.folders.has(folder)) prefixes.add(folder);
	}
	const oldLinks = before.collected.links;
	const newLinks = after.collected.links;
	for (const module of new Set([...oldLinks.keys(), ...newLinks.keys()])) {
		if (JSON.stringify(oldLinks.get(module)) === JSON.stringify(newLinks.get(module))) continue;
		addRelated(module);
		for (const collected of [before.collected, after.collected]) {
			const target = collected.targets.get(module);
			if (target !== undefined) addRelated(target);
			if (collected.directoryLinks.has(module)) prefixes.add(module);
		}
	}
	return { modules, prefixes: [...prefixes].sort() };
}

export interface SecretPolicyInitialOptions {
	root: string;
	judge?: string;
	clock?: Clock;
	store?: Pick<IndexStore, "lastSecretPolicy" | "rememberSecretPolicy">;
	runGit?: GitRunner;
	walkBound?: number;
	linkFs?: LinkEvidenceFileSystem;
}

function adoptedConfig(
	read: ScopeConfigRead,
	previous: ScopeConfig,
	persisted: SecretPolicyConfig | null,
): { config: ScopeConfig; notes: string[] } {
	const fallback =
		persisted === null
			? {
					secrets: previous.secrets ?? {},
					deny: [...(previous.deny ?? [])],
				}
			: { secrets: persisted.secrets, deny: [...persisted.deny] };
	const hadValidSecrets = persisted !== null || previous.secrets !== undefined || previous.deny !== undefined;
	switch (read.kind) {
		case "absent":
			return { config: fallback, notes: [] };
		case "valid":
			return { config: read.config, notes: [] };
		case "invalidSecrets":
			return {
				config: { ...read.config, secrets: fallback.secrets },
				notes: [invalidSecretsNote(read.glob, hadValidSecrets)],
			};
		case "malformed":
			return {
				config: { ...previous, ...fallback },
				notes: [malformedConfigNote(hadValidSecrets)],
			};
	}
}

function invalidSecretsNote(glob: string | null, hadValidSecrets: boolean): string {
	const active = hadValidSecrets ? "last valid" : "built-in";
	return glob === null
		? `lexicon.json secrets is invalid; ${active} secret rules are active`
		: `lexicon.json secret glob "${glob}" is invalid; ${active} secret rules are active`;
}

function malformedConfigNote(hadValidSecrets: boolean): string {
	return `lexicon.json is invalid; ${hadValidSecrets ? "last valid" : "built-in"} secret rules are active`;
}

function readScopeConfig(source: string | null): ScopeConfigRead {
	if (source === null) return { kind: "absent" };
	try {
		const parsed = JSON.parse(source) as {
			include?: unknown;
			exclude?: unknown;
			deny?: unknown;
			bundles?: unknown;
			fix?: unknown;
			fixText?: unknown;
			secrets?: unknown;
		};
		const paths = (value: unknown): string[] =>
			Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
		// Invalid command arrays are ignored whole.
		const command = (value: unknown): string[] | undefined =>
			Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string")
				? (value as string[])
				: undefined;
		const fix = command(parsed.fix);
		const fixText = command(parsed.fixText);
		const secrets = parsed.secrets === undefined ? undefined : SecretsConfigSchema.safeParse(parsed.secrets);
		const invalidSecretGlobPath =
			secrets !== undefined && !secrets.success
				? secrets.error.issues.find((issue) => issue.message === "invalid secret glob")?.path[0]
				: undefined;
		const invalidSecretGlob = typeof invalidSecretGlobPath === "string" ? invalidSecretGlobPath : undefined;
		const config: ScopeConfig = {
			include: paths(parsed.include),
			exclude: paths(parsed.exclude),
			deny: paths(parsed.deny),
			bundles: paths(parsed.bundles),
			...(secrets === undefined ? {} : secrets.success ? { secrets: secrets.data } : {}),
			...(fix === undefined ? {} : { fix }),
			...(fixText === undefined ? {} : { fixText }),
		};
		return secrets !== undefined && !secrets.success
			? { kind: "invalidSecrets", config, glob: invalidSecretGlob ?? null }
			: { kind: "valid", config };
	} catch {
		return { kind: "malformed" };
	}
}

function readPolicyConfig(root: string): ScopeConfigRead {
	const source = unseal(readSource(root, CONFIG_FILE));
	if (source.kind === "missing") return { kind: "absent" };
	if (source.kind !== "text") return { kind: "malformed" };
	return readScopeConfig(source.text);
}

function admissionConfig(config: ScopeConfig): { secrets: SecretsConfig; deny: string[] } {
	return { secrets: config.secrets ?? {}, deny: [...(config.deny ?? [])] };
}

export class SecretPolicy {
	private readonly evidenceValue: PolicyEvidence;
	private readonly root: string;
	private readonly journalJudge: string;
	private readonly store: SecretPolicyInitialOptions["store"];
	private readonly clock: Clock;
	private configValue: ScopeConfig;
	private snapshot: SecretPolicySnapshot;
	private discoverySnapshot: SecretPolicySnapshot;
	private installedScope: import("./fileScope.js").FileScope | null = null;
	private consumers: { index: PolicyIndex; journal: PolicyJournal; providers: PolicyProviders } | null = null;
	private change: PolicyChange | null = null;
	private notesValue: readonly string[] = [];
	private auditTimer: TimerHandle | null = null;

	private constructor(options: SecretPolicyInitialOptions) {
		this.root = options.root;
		this.journalJudge = options.judge ?? randomUUID();
		this.store = options.store;
		this.clock = options.clock ?? systemClock;
		this.evidenceValue = new PolicyEvidence(
			options.root,
			this.clock,
			options.runGit,
			options.walkBound,
			options.linkFs,
		);
		const persisted = options.store?.lastSecretPolicy() ?? null;
		this.configValue = persisted === null ? {} : { secrets: persisted.secrets, deny: persisted.deny };
		this.snapshot = new SecretPolicySnapshot(this.evidenceValue.initial(this.configValue), snapshotOwner, () =>
			this.evidenceValue.markStale("links"),
		);
		this.discoverySnapshot = this.snapshot;
	}

	static initial(options: SecretPolicyInitialOptions): SecretPolicy {
		return new SecretPolicy(options);
	}

	private journalStamp(module: string): string | null {
		const answer = this.snapshot.answer(module);
		return answer.kind === "plain"
			? null
			: hashContent(JSON.stringify([this.journalJudge, SECRET_SYNTAX_VERSION, answer.stamp]));
	}

	private mintJournalAdmission(module: string, hash: string, stamp: string | null): JournalAdmission {
		return { module, hash, stamp } as JournalAdmission;
	}

	/** Admit bytes under policy. */
	admitBytes(module: string, bytes: Uint8Array): JournalBytesResult {
		const stamp = this.journalStamp(module);
		if (stamp !== null) {
			const read = sourceReadBytes(module, bytes);
			const verdict = this.snapshot.verdict(read);
			if (verdict.admission.as !== "plain")
				return {
					kind: "withheld",
					reason: secretFile(module),
					view: this.viewAdmission(module, read, stamp),
				};
		}
		const admission = this.mintJournalAdmission(module, hashBytes(bytes), stamp);
		return { kind: "admitted", value: { ...admission, bytes } as AdmittedBytes };
	}

	private viewAdmission(module: string, read: SealedRead, stamp: string): JournalAdmission {
		const view = this.snapshot.view(read);
		const hash = "hash" in view ? view.hash : hashContent(JSON.stringify({ module, kind: view.kind }));
		return this.mintJournalAdmission(module, hash, stamp);
	}

	/** Confirm a stored admission. */
	confirm(stored: StoredAdmission, load: () => Uint8Array | null): JournalAdmissionResult<JournalAdmission> {
		const stamp = this.journalStamp(stored.module);
		if (stored.stamp === stamp)
			return { kind: "admitted", value: this.mintJournalAdmission(stored.module, stored.hash, stamp) };
		const bytes = load();
		if (bytes === null) return { kind: "withheld", reason: secretFile(stored.module) };
		const result = this.confirmHeld(stored, bytes);
		if (result.kind === "withheld") return result;
		return {
			kind: "admitted",
			value: this.mintJournalAdmission(result.value.module, result.value.hash, result.value.stamp),
		};
	}

	/** Check held bytes before admission. */
	confirmHeld(stored: StoredAdmission, bytes: Uint8Array): JournalAdmissionResult<AdmittedBytes> {
		const result = this.admitBytes(stored.module, bytes);
		if (result.kind === "withheld") return result;
		return result.value.hash === stored.hash ? result : { kind: "withheld", reason: secretFile(stored.module) };
	}

	get current(): SecretPolicySnapshot {
		return this.snapshot;
	}

	get genericWithheldDetail(): string {
		return SECRET_DETAILS_WITHHELD;
	}

	get revision(): string {
		return this.snapshot.revision;
	}

	discovers(module: string): boolean {
		return this.discoverySnapshot.discovers(module);
	}

	get config(): ScopeConfig {
		return this.configValue;
	}

	get notes(): readonly string[] {
		return this.notesValue;
	}

	get evidence(): PolicyEvidence {
		return this.evidenceValue;
	}

	get evidenceInputs(): readonly import("./policyEvidence.js").PolicyEvidenceInput[] {
		return this.evidenceValue.current()?.inputs ?? [];
	}

	get lastChange(): PolicyChange | null {
		return this.change;
	}

	attach(consumers: { index: PolicyIndex; journal: PolicyJournal; providers: PolicyProviders }): void {
		this.consumers = consumers;
		this.armAudit();
	}

	async refresh(trigger: PolicyTrigger): Promise<PolicyChange> {
		const consumers = this.consumers;
		if (consumers === null) throw new Error("secret policy consumers are not attached");
		const previousView = this.evidenceValue.current();
		const previousSubscriptions = this.evidenceValue.subscriptions();
		const requested = new Set<EvidenceKind>(
			trigger.kind === "startup" || trigger.kind === "audit" ? ["config"] : [],
		);
		if (trigger.kind === "events") {
			for (const module of trigger.modules)
				for (const kind of this.evidenceValue.inputsFor({ module })) requested.add(kind);
			for (const kind of trigger.evidence ?? []) requested.add(kind);
		}
		for (const kind of this.evidenceValue.verifySubscriptions()) requested.add(kind);
		if (this.evidenceValue.isStale("links")) requested.add("links");
		const changedFiles = trigger.kind === "events" ? (trigger.changed ?? []) : [];
		this.evidenceValue.addUntracked(changedFiles);
		const readsConfig =
			previousView === null || requested.has("config") || trigger.kind === "startup" || trigger.kind === "audit";
		const read = readsConfig ? readPolicyConfig(this.root) : (previousView?.configRead ?? { kind: "absent" });
		const adopted = readsConfig
			? adoptedConfig(read, this.configValue, this.store?.lastSecretPolicy() ?? null)
			: { config: this.configValue, notes: this.notesValue as string[] };
		const previousDiscovery = this.discoverySnapshot;
		this.discoverySnapshot = new SecretPolicySnapshot(
			this.evidenceValue.initial(adopted.config),
			snapshotOwner,
			() => this.evidenceValue.markStale("links"),
		);
		let view = this.evidenceValue.current();
		try {
			if (trigger.kind === "startup" || trigger.kind === "audit") requested.add("config");
			if (requested.size > 0 || view === null) {
				view = (
					await this.evidenceValue.refresh(
						read,
						adopted.config,
						(module) => this.discovers(module),
						[...requested],
						changedFiles,
					)
				).after;
			} else {
				view = this.evidenceValue.current();
			}
		} catch (error) {
			this.discoverySnapshot = previousDiscovery;
			throw error;
		}
		if (view === null) throw new Error("secret policy evidence is not initialized");
		const affected = trigger.kind === "startup" ? "all" : affectedBetween(previousView, view);
		const sameView = previousView === view && JSON.stringify(this.configValue) === JSON.stringify(adopted.config);
		const nextSnapshot = sameView
			? this.snapshot
			: new SecretPolicySnapshot(view, snapshotOwner, () => this.evidenceValue.markStale("links"), {
					snapshot: this.snapshot,
					affected,
				});
		this.discoverySnapshot = nextSnapshot;
		const scope = scopeFor(view, nextSnapshot);
		if (readsConfig && read.kind === "valid") {
			const persisted = admissionConfig(read.config);
			if (JSON.stringify(this.store?.lastSecretPolicy() ?? null) !== JSON.stringify(persisted))
				this.store?.rememberSecretPolicy(persisted);
		}
		const previousRevision = this.snapshot.revision;
		const moved = previousRevision !== nextSnapshot.revision;
		const admissionMoved =
			this.installedScope === null ||
			JSON.stringify([
				this.installedScope.include,
				this.installedScope.exclude,
				this.installedScope.deny,
				this.installedScope.bundles,
			]) !== JSON.stringify([scope.include, scope.exclude, scope.deny, scope.bundles]);
		const subscriptionsMoved =
			JSON.stringify(previousSubscriptions) !== JSON.stringify(this.evidenceValue.subscriptions());
		const change: PolicyChange = {
			revision: nextSnapshot.revision,
			moved,
			affected,
			admissionMoved,
			subscriptionsMoved,
		};
		const notes = [
			...adopted.notes,
			...[...view.collected.undiscovered].sort().map((folder) => `undiscovered ignored folder: ${folder}`),
		];
		this.install(adopted.config, nextSnapshot, scope, change, notes);
		return change;
	}

	private install(
		config: ScopeConfig,
		snapshot: SecretPolicySnapshot,
		scope: import("./fileScope.js").FileScope,
		change: PolicyChange,
		notes: readonly string[],
	): void {
		this.configValue = config;
		this.snapshot = snapshot;
		this.installedScope = scope;
		this.notesValue = notes;
		this.change = change;
		const consumers = this.consumers;
		if (consumers === null) throw new Error("secret policy consumers are not attached");
		const affected =
			change.affected === "all" || change.affected.modules.size > 0 || change.affected.prefixes.length > 0;
		if (affected || change.admissionMoved) consumers.index.installScope(scope, change);
	}

	private armAudit(): void {
		if (this.auditTimer !== null) this.clock.clearTimer(this.auditTimer);
		this.auditTimer = this.clock.setTimer(() => {
			this.auditTimer = null;
			const audit = this.consumers?.index.auditPolicy;
			if (audit !== undefined)
				void audit
					.call(this.consumers?.index)
					.catch(() => {})
					.finally(() => this.armAudit());
			else this.armAudit();
		}, POLICY_AUDIT_MS);
	}

	policyChanged(change: PolicyChange): void {
		if (this.consumers === null) throw new Error("secret policy consumers are not attached");
		this.consumers.journal.policyChanged(change);
		this.consumers.providers.policyChanged(change);
	}
}
