import { lstatSync, statSync } from "node:fs";
import { hashContent, workspaceFile } from "@nyaa-lexicon/protocol";
import { type Clock, systemClock } from "./clock.js";
import {
	CONFIG_FILE,
	type CollectedScopeEvidence,
	collectScopeEvidence,
	collectScopeEvidenceFromRepositories,
	type GitRunner,
	type LinkEvidenceFileSystem,
	refreshScopeEvidence,
	type ScopeConfig,
	type ScopeConfigRead,
} from "./fileScope.js";
import { type FileStamp, type GitRepository, sameStamp } from "./gitEvidence.js";

////////////////////////////////
//  Interfaces & Types

export type EvidenceKind = "config" | "repositories" | "links" | `listing:${string}` | `ignored:${string}`;

export interface PolicyEvidenceInput {
	kind: EvidenceKind;
	value: unknown;
	digest: string;
	feeds: readonly ("answer" | "admission" | "subscriptions")[];
	invalidators: readonly string[];
	derivedAfter: readonly EvidenceKind[];
	subscriptions: readonly EvidencePath[];
}

export interface EvidencePath {
	path: string;
	fingerprint: string;
}

export interface EvidenceSubscription extends EvidencePath {
	keys: readonly EvidenceKind[];
}

const evidenceViewBrand: unique symbol = Symbol("EvidenceView");

export interface EvidenceView {
	readonly collected: CollectedScopeEvidence;
	readonly configRead: ScopeConfigRead;
	readonly config: ScopeConfig;
	readonly inputs: readonly PolicyEvidenceInput[];
	readonly revision: string;
	readonly [evidenceViewBrand]: true;
}

////////////////////////////////
//  Functions & Helpers

export function evidenceInputsFor(
	collected: CollectedScopeEvidence,
	configRead: ScopeConfigRead,
	config: ScopeConfig,
	root?: string,
): PolicyEvidenceInput[] {
	const configInput = input(
		"config",
		{ read: configRead, adopted: config },
		{
			answer: { secrets: config.secrets ?? {}, deny: config.deny ?? [] },
			scope: {
				include: config.include ?? [],
				exclude: config.exclude ?? [],
				bundles: config.bundles ?? [],
			},
		},
		["answer", "admission", "subscriptions"],
		[CONFIG_FILE],
		[],
		root === undefined ? [] : moduleSubscription(root, CONFIG_FILE),
	);
	const repositoriesInput = input(
		"repositories",
		collected.repositories.map(({ prefix, gitDir, indexPath, state }) => ({ prefix, gitDir, indexPath, state })),
		collected.repositories.map(({ prefix, state }) => [prefix, state]),
		["answer", "subscriptions"],
		[".git", ...collected.repositories.map(({ prefix }) => (prefix === "" ? ".git" : `${prefix}/.git`))],
		["config", ...collected.repositories.map(({ prefix }) => listingKind(prefix))],
	);
	const listingInputs = collected.repositories.map((repository) => {
		const kind = listingKind(repository.prefix);
		const invalidators = [`${repository.prefix === "" ? "" : `${repository.prefix}/`}.gitignore`];
		return input(
			kind,
			{
				state: repository.state,
				tracked: repository.tracked,
				links: repository.links,
				gitlinks: repository.gitlinks,
				untracked: repository.untracked,
				nested: repository.nested,
				externals: repository.externals,
			},
			{
				state: repository.state,
				tracked: repository.tracked,
				untracked: repository.untracked,
				discovered: repository.discovered,
				nested: repository.nested,
			},
			["answer", "admission", "subscriptions"],
			invalidators,
			["config"],
			externalSubscriptions([repository], ["index", "exclude", "excludesFile"]),
		);
	});
	const ignoredInputs = collected.repositories.map((repository) => {
		const kind = ignoredKind(repository.prefix);
		const listing = listingKind(repository.prefix);
		return input(
			kind,
			{ discovered: repository.discovered, undiscovered: repository.undiscovered },
			repository.discovered,
			["admission"],
			[
				`${repository.prefix === "" ? "" : `${repository.prefix}/`}.gitignore`,
				`${repository.prefix === "" ? "" : `${repository.prefix}/`}.gitignore`,
			],
			["config", listing],
			externalSubscriptions([repository], ["index", "exclude", "excludesFile"]),
		);
	});
	const linksInput = input(
		"links",
		{
			links: collected.links,
			aliasesByTarget: collected.aliasesByTarget,
			targets: collected.targets,
			directoryLinks: collected.directoryLinks,
		},
		{
			links: collected.links,
			aliasesByTarget: collected.aliasesByTarget,
			targets: collected.targets,
			directoryLinks: collected.directoryLinks,
		},
		["answer"],
		linkInvalidators(collected),
		[...listingInputs.map(({ kind }) => kind), ...ignoredInputs.map(({ kind }) => kind)],
	);
	return [configInput, repositoriesInput, ...listingInputs, ...ignoredInputs, linksInput];
}

function linkInvalidators(collected: CollectedScopeEvidence): string[] {
	const invalidators = new Set<string>();
	for (const [link, evidence] of collected.links) {
		invalidators.add(link);
		if (evidence.kind === "file" || evidence.kind === "directory") invalidators.add(evidence.target);
	}
	for (const [target, aliases] of collected.aliasesByTarget) {
		invalidators.add(target);
		for (const alias of aliases) invalidators.add(alias);
	}
	for (const [alias, target] of collected.targets) {
		invalidators.add(alias);
		invalidators.add(target);
	}
	return [...invalidators];
}

export function evidenceRevision(inputs: readonly PolicyEvidenceInput[]): string {
	return digest(
		inputs
			.filter(
				({ kind, feeds }) =>
					kind === "config" ||
					kind === "repositories" ||
					kind === "links" ||
					(!kind.startsWith("listing:") && !kind.startsWith("ignored:") && feeds.includes("answer")),
			)
			.map(({ kind, digest: value }) => [kind, value]),
	);
}

function input(
	kind: EvidenceKind,
	value: unknown,
	digestValue: unknown,
	feeds: PolicyEvidenceInput["feeds"],
	invalidators: readonly string[],
	derivedAfter: readonly EvidenceKind[],
	subscriptions: readonly EvidencePath[] = [],
): PolicyEvidenceInput {
	return { kind, value, digest: digest(digestValue), feeds, invalidators, derivedAfter, subscriptions };
}

function externalSubscriptions(
	repositories: readonly GitRepository[],
	kinds: readonly GitRepository["externals"][number]["kind"][],
): EvidencePath[] {
	return repositories.flatMap((repository) =>
		repository.externals
			.filter((external) => kinds.includes(external.kind))
			.map((external) => ({ path: external.path, fingerprint: stampFingerprint(external.stamp) })),
	);
}

function moduleSubscription(root: string, module: string): EvidencePath[] {
	const file = workspaceFile(root, module);
	if (file === null) return [];
	let fingerprint = "missing";
	try {
		const stat = statSync(file);
		fingerprint = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
	} catch {}
	return [{ path: file, fingerprint }];
}

function stampFingerprint(stamp: FileStamp | null): string {
	return stamp === null ? "missing" : `${stamp.mtimeMs}:${stamp.size}:${stamp.ino}`;
}

function fingerprintStamp(fingerprint: string): FileStamp | null {
	if (fingerprint === "missing") return null;
	const [mtimeMs, size, ino] = fingerprint.split(":").map(Number);
	if (mtimeMs === undefined || size === undefined || ino === undefined) return null;
	return { mtimeMs, size, ino };
}

function listingKind(prefix: string): EvidenceKind {
	return `listing:${prefix}`;
}

function ignoredKind(prefix: string): EvidenceKind {
	return `ignored:${prefix}`;
}

function makeEvidenceView(view: Omit<EvidenceView, typeof evidenceViewBrand>): EvidenceView {
	return { ...view, [evidenceViewBrand]: true };
}

function stableValue(value: unknown): unknown {
	if (value instanceof Set) return [...value].sort();
	if (value instanceof Map)
		return [...value.entries()]
			.map(([key, entry]) => [key, stableValue(entry)])
			.sort(([left], [right]) => String(left).localeCompare(String(right)));
	if (Array.isArray(value)) return value.map(stableValue);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => [key, stableValue(entry)]),
		);
	}
	return value;
}

function digest(value: unknown): string {
	return hashContent(JSON.stringify(stableValue(value)));
}

////////////////////////////////
//  Class

export class PolicyEvidence {
	private view: EvidenceView | null = null;
	private readonly subscriptionListeners = new Set<() => void>();
	private readonly staleInputs = new Set<EvidenceKind>();

	constructor(
		private readonly root: string,
		private readonly clock: Clock = systemClock,
		private readonly runGit?: GitRunner,
		private readonly walkBound?: number,
		private readonly linkFs?: LinkEvidenceFileSystem,
	) {}

	initial(config: ScopeConfig): EvidenceView {
		const collected: CollectedScopeEvidence = {
			known: null,
			tracking: { kind: "failed" },
			repositories: [],
			modules: new Set(),
			links: new Map(),
			aliasesByTarget: new Map(),
			targets: new Map(),
			directoryLinks: new Map(),
			ignoredSecrets: new Set(),
			undiscovered: new Set(),
			entries: new Map(),
		};
		return makeEvidenceView({
			collected,
			configRead: { kind: "absent" },
			config,
			inputs: [],
			revision: "",
		});
	}

	async collect(
		configRead: ScopeConfigRead,
		config: ScopeConfig,
		discovers: (module: string) => boolean,
	): Promise<EvidenceView> {
		const previousSubscriptions = this.subscriptions();
		const collected = await collectScopeEvidence(
			this.root,
			config,
			discovers,
			this.clock,
			this.runGit,
			this.walkBound,
			this.linkFs,
		);
		const inputs = evidenceInputsFor(collected, configRead, config, this.root);
		this.view = makeEvidenceView({
			collected,
			configRead,
			config,
			inputs,
			revision: evidenceRevision(inputs),
		});
		this.staleInputs.clear();
		if (JSON.stringify(previousSubscriptions) !== JSON.stringify(this.subscriptions()))
			for (const listener of this.subscriptionListeners) listener();
		return this.view;
	}

	async refresh(
		configRead: ScopeConfigRead,
		config: ScopeConfig,
		discovers: (module: string) => boolean,
		requested: readonly EvidenceKind[],
		linkModules: readonly string[] = [],
	): Promise<{ before: EvidenceView | null; after: EvidenceView }> {
		const before = this.view;
		const previousSubscriptions = this.subscriptions();
		const full = before === null || requested.includes("config") || requested.includes("repositories");
		const prefixes = new Set<string>();
		for (const kind of requested) {
			if (kind.startsWith("listing:")) prefixes.add(kind.slice("listing:".length));
			if (kind.startsWith("ignored:")) prefixes.add(kind.slice("ignored:".length));
		}
		const collected = await refreshScopeEvidence(
			this.root,
			config,
			discovers,
			before?.collected ?? (await this.emptyCollected()),
			{ full, prefixes: [...prefixes], linkModules: requested.includes("links") ? linkModules : [] },
			this.clock,
			this.runGit,
			this.walkBound,
			this.linkFs,
		);
		const inputs = evidenceInputsFor(collected, configRead, config, this.root);
		const after = makeEvidenceView({
			collected,
			configRead,
			config,
			inputs,
			revision: evidenceRevision(inputs),
		});
		this.view = after;
		if (full) this.staleInputs.clear();
		else for (const kind of requested) this.staleInputs.delete(kind);
		this.notifySubscriptions(previousSubscriptions);
		return { before, after };
	}

	addUntracked(modules: readonly string[]): EvidenceView | null {
		const previous = this.view;
		if (previous === null || previous.collected.known === null) return previous;
		const repositories = previous.collected.repositories.map((repository) => ({
			...repository,
			untracked: new Set(repository.untracked),
		}));
		let changed = false;
		for (const module of modules) {
			if (previous.collected.known.has(module)) continue;
			if (
				repositories.some((repository) =>
					[...repository.gitlinks].some((root) => module === root || module.startsWith(`${root}/`)),
				)
			)
				continue;
			const owner = repositories
				.filter(
					(repository) =>
						repository.state === "ok" &&
						(repository.prefix === "" || module.startsWith(`${repository.prefix}/`)),
				)
				.sort((left, right) => right.prefix.length - left.prefix.length)[0];
			if (owner === undefined) continue;
			owner.untracked.add(module);
			changed = true;
		}
		if (!changed) return previous;
		const collected = collectScopeEvidenceFromRepositories(this.root, repositories, this.linkFs);
		const inputs = evidenceInputsFor(collected, previous.configRead, previous.config, this.root);
		this.view = makeEvidenceView({
			collected,
			configRead: previous.configRead,
			config: previous.config,
			inputs,
			revision: evidenceRevision(inputs),
		});
		return this.view;
	}

	verifySubscriptions(): EvidenceKind[] {
		const changed = new Set<EvidenceKind>();
		for (const subscription of this.subscriptions()) {
			let current: FileStamp | null = null;
			try {
				const stat = statSync(subscription.path);
				current = { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
			} catch {}
			if (sameStamp(fingerprintStamp(subscription.fingerprint), current)) continue;
			for (const kind of subscription.keys) changed.add(kind);
		}
		return [...changed];
	}

	current(): EvidenceView | null {
		return this.view;
	}

	onSubscriptionsChanged(listener: () => void): () => void {
		this.subscriptionListeners.add(listener);
		return () => this.subscriptionListeners.delete(listener);
	}

	subscriptions(): EvidenceSubscription[] {
		const grouped = new Map<string, { fingerprint: string; keys: Set<EvidenceKind> }>();
		for (const input of this.view?.inputs ?? []) {
			if (!input.feeds.includes("subscriptions")) continue;
			for (const subscription of input.subscriptions) {
				const current = grouped.get(subscription.path) ?? {
					fingerprint: subscription.fingerprint,
					keys: new Set<EvidenceKind>(),
				};
				current.keys.add(input.kind);
				grouped.set(subscription.path, current);
			}
		}
		return [...grouped]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([subscriptionPath, { fingerprint, keys }]) => ({
				path: subscriptionPath,
				keys: [...keys],
				fingerprint,
			}));
	}

	inputsFor(event: { module: string }): readonly EvidenceKind[] {
		const { module } = event;
		if (this.view === null) return ["config", "repositories", "listing:", "ignored:", "links"];
		const matched = this.view.inputs.filter((input) => input.invalidators.includes(module)).map(({ kind }) => kind);
		if (this.staleInputs.has("links") && !matched.includes("links")) matched.push("links");
		if (matched.includes("links")) return matched;
		const file = workspaceFile(this.root, module);
		if (file !== null) {
			try {
				if (lstatSync(file).isSymbolicLink()) return [...matched, "links"];
			} catch {}
		}
		return matched;
	}

	/** Linked aliases for path. */
	aliasesOf(module: string): string[] {
		const collected = this.view?.collected;
		if (collected === undefined) return [];
		const aliases = new Set<string>();
		const pending = [module];
		for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
			for (const alias of collected.aliasesByTarget.get(current) ?? []) {
				if (aliases.has(alias)) continue;
				aliases.add(alias);
				pending.push(alias);
			}
			for (const [alias, target] of collected.directoryLinks) {
				if (current !== target && !current.startsWith(`${target}/`)) continue;
				const linked = `${alias}${current.slice(target.length)}`;
				if (linked === module || aliases.has(linked)) continue;
				aliases.add(linked);
				pending.push(linked);
			}
		}
		aliases.delete(module);
		return [...aliases].sort();
	}

	markStale(kind: EvidenceKind): void {
		this.staleInputs.add(kind);
	}

	isStale(kind: EvidenceKind): boolean {
		return this.staleInputs.has(kind);
	}

	private notifySubscriptions(previous: readonly EvidenceSubscription[]): void {
		if (JSON.stringify(previous) !== JSON.stringify(this.subscriptions()))
			for (const listener of this.subscriptionListeners) listener();
	}

	private async emptyCollected(): Promise<CollectedScopeEvidence> {
		return {
			known: null,
			tracking: { kind: "failed" },
			repositories: [],
			modules: new Set(),
			links: new Map(),
			aliasesByTarget: new Map(),
			targets: new Map(),
			directoryLinks: new Map(),
			ignoredSecrets: new Set(),
			undiscovered: new Set(),
			entries: new Map(),
		};
	}
}
