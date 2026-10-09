import type {
	ArrangeFile,
	JudgeLoadCycleAnswer,
	PrepareLoadCyclePreviewRequest,
	PrepareLoadCyclePreviewResponse,
} from "@nyaa-lexicon/protocol";
import { ModuleCycleSchema, sameRange } from "@nyaa-lexicon/protocol";
import type { Clock } from "./clock.js";
import { DeadlineError } from "./deadline.js";
import { type Cycle, newCycleComponents, previewComponents, withPreviewComponents } from "./loadCycles.js";
import type { ProviderPort } from "./providerPort.js";
import type { ProviderProbe } from "./providerProbe.js";
import type { Gate } from "./stepRunners.js";
import { type IndexStore, type ReplaceFileInput, resolutionKey } from "./store.js";
import { ProviderUnavailableError } from "./supervisor.js";

type Result = ReturnType<typeof ModuleCycleSchema.parse>;
type UnknownReason = Result["unknowns"][number]["reason"];
type PreviewJudgment = { result: Result; evidence?: Extract<JudgeLoadCycleAnswer, { verdict: unknown }> };

const MAX_PREVIEWS = 4;
const MAX_JUDGE_SLICES = 4;
const PREVIEW_BUDGET_MS = 1200;

function unknown(cycle: Cycle, reason: UnknownReason): Result {
	return ModuleCycleSchema.parse({
		modules: cycle.modules,
		verdict: "unknown",
		entries: cycle.entries,
		crossingCount: cycle.crossingCount,
		crossings: cycle.crossings,
		bad: [],
		unknowns: [{ reason }],
	});
}

function inputOf(
	provider: string,
	answer: Extract<PrepareLoadCyclePreviewResponse, { status: "ready" }>,
): ReplaceFileInput[] {
	return answer.facts.map((facts) => ({
		module: facts.module,
		contentHash: facts.contentHash,
		declarations: facts.declarations,
		references: facts.references,
		imports: facts.imports,
		...(facts.literals === undefined ? {} : { literals: facts.literals }),
		...(facts.depth === undefined ? {} : { depth: facts.depth }),
		provider,
		...(facts.runtime === undefined ? {} : { runtime: facts.runtime }),
		...(facts.exports === undefined ? {} : { exports: facts.exports }),
		...(facts.role === undefined ? {} : { role: facts.role }),
		...(facts.allList === undefined ? {} : { allList: facts.allList }),
		...(facts.scopeContributions === undefined ? {} : { scopeContributions: facts.scopeContributions }),
		resolutions: new Map(
			answer.landings
				.filter((landing) => landing.module === facts.module)
				.map(
					(landing) =>
						[resolutionKey(landing.specifier, landing.resolutionMode), landing.resolution] as const,
				),
		),
	}));
}

function hashes(store: IndexStore, files: readonly ArrangeFile[]): Map<string, string> {
	return new Map(files.map((file) => [file.module, file.result]));
}

function baselineHashes(store: IndexStore, files: readonly ArrangeFile[]): Map<string, string | null> {
	return new Map(files.map((file) => [file.module, store.contentHashOf(file.module)]));
}

function baselineStillHolds(
	store: IndexStore,
	providers: ProviderPort,
	files: readonly ArrangeFile[],
	bases: ReadonlyMap<string, string | null>,
	owners: ReadonlyMap<string, { id: string; incarnation: number; fingerprint: string | null }>,
	revision: number,
): boolean {
	if (store.factsRevision() !== revision) return false;
	if (files.some((file) => store.contentHashOf(file.module) !== bases.get(file.module))) return false;
	for (const [module, owner] of owners) {
		const route = providers.route(module);
		if (
			!route.owned ||
			route.providerId !== owner.id ||
			providers.incarnationOf(owner.id) !== owner.incarnation ||
			store.projectFingerprint(owner.id) !== owner.fingerprint
		)
			return false;
	}
	return true;
}

function landingsHold(store: IndexStore, answer: Extract<JudgeLoadCycleAnswer, { verdict: unknown }>): boolean {
	for (const evidence of answer.evidence) {
		if (store.contentHashOf(evidence.module) !== evidence.contentHash) return false;
		const imports = store.importsIn(evidence.module);
		for (const item of evidence.landings) {
			const occurrence = imports.find((edge) => sameRange(edge.span, item.range));
			if (occurrence === undefined || JSON.stringify(occurrence.landing) !== JSON.stringify(item.landing))
				return false;
		}
	}
	return true;
}

async function prepare(
	probe: ProviderProbe,
	provider: string,
	files: readonly ArrangeFile[],
	answer: readonly string[],
): Promise<PrepareLoadCyclePreviewResponse> {
	const request: PrepareLoadCyclePreviewRequest = {
		files: files.map(({ module, base, result, text }) => ({ module, base, contentHash: result, text })),
		answer: [...answer],
	};
	if (probe.prepareLoadCyclePreview === undefined) return { status: "unsupported" };
	try {
		return await probe.prepareLoadCyclePreview(provider, request);
	} catch (error) {
		return {
			status: "unknown",
			reason:
				error instanceof DeadlineError
					? "timeout"
					: error instanceof ProviderUnavailableError
						? "outage"
						: "provider",
		};
	}
}

async function judge(
	providers: ProviderPort,
	cycle: Cycle,
	preview: string,
	members: Array<{ module: string; contentHash: string }>,
	owner: string,
	incarnation: number,
	fingerprint: string,
): Promise<PreviewJudgment> {
	let partial: string | undefined;
	try {
		for (let slice = 0; slice < MAX_JUDGE_SLICES; slice++) {
			const reply = (await providers.askProvider(owner, "judgeLoadCycle", {
				preview,
				members,
				entries: cycle.entries,
				...(partial === undefined ? {} : { partial }),
			})) as JudgeLoadCycleAnswer;
			if (reply.preview !== preview) return { result: unknown(cycle, "evidence") };
			if ("partial" in reply) {
				partial = reply.partial;
				continue;
			}
			partial = undefined;
			const evidence = new Map(reply.evidence.map((row) => [row.module, row]));
			if (
				evidence.size !== reply.evidence.length ||
				members.some((member) => evidence.get(member.module)?.contentHash !== member.contentHash) ||
				(reply.verdict !== "unknown" &&
					(reply.settings.length !== 1 ||
						reply.settings[0]?.project !== owner ||
						reply.settings[0]?.fingerprint !== fingerprint)) ||
				(reply.verdict === "bad") !== reply.bad.length > 0 ||
				reply.bad.some(
					(hazard) =>
						!cycle.entries.includes(hazard.entry) ||
						!cycle.modules.includes(hazard.reader.module) ||
						!cycle.modules.includes(hazard.target.module) ||
						!hazard.order.every((module) => cycle.modules.includes(module)),
				)
			)
				return { result: unknown(cycle, "evidence") };
			return {
				result: ModuleCycleSchema.parse({
					modules: cycle.modules,
					verdict: reply.verdict,
					entries: cycle.entries,
					crossingCount: cycle.crossingCount,
					crossings: cycle.crossings,
					bad: reply.bad,
					unknowns: reply.unknowns,
				}),
				evidence: reply,
			};
		}
		return { result: unknown(cycle, "budget") };
	} catch (error) {
		return {
			result: unknown(
				cycle,
				error instanceof DeadlineError
					? "timeout"
					: error instanceof ProviderUnavailableError
						? "outage"
						: "refused",
			),
		};
	} finally {
		if (partial !== undefined) providers.releaseJudgment(owner, incarnation, partial);
	}
}

export async function previewLoadCycles(
	store: IndexStore,
	providers: ProviderPort,
	probe: ProviderProbe,
	clock: Clock,
	gate: Gate,
	files: readonly ArrangeFile[],
): Promise<Result[]> {
	if (files.length === 0) return [];
	const bases = baselineHashes(store, files);
	const owners = new Map<string, { id: string; incarnation: number; fingerprint: string | null }>();
	for (const file of files) {
		const route = providers.route(file.module);
		if (!route.owned) return [];
		const incarnation = providers.incarnationOf(route.providerId);
		if (incarnation === null) return [];
		owners.set(file.module, {
			id: route.providerId,
			incarnation,
			fingerprint: store.projectFingerprint(route.providerId),
		});
	}
	const baselineView = await gate.write(() => {
		const cycles = previewComponents(store, []);
		for (const module of cycles.flatMap((cycle) => cycle.modules)) {
			if (owners.has(module)) continue;
			const route = providers.route(module);
			if (!route.owned) continue;
			const incarnation = providers.incarnationOf(route.providerId);
			if (incarnation === null) continue;
			owners.set(module, {
				id: route.providerId,
				incarnation,
				fingerprint: store.projectFingerprint(route.providerId),
			});
		}
		return { revision: store.factsRevision(), cycles };
	});
	const baseline = baselineView.cycles;
	const revision = baselineView.revision;
	const prepared: Array<{
		owner: string;
		incarnation: number;
		token: string;
		facts: ReplaceFileInput[];
		response: Extract<PrepareLoadCyclePreviewResponse, { status: "ready" }>;
	}> = [];
	const tokens: Array<{ owner: string; incarnation: number; token: string }> = [];
	const expiry = clock.now() + PREVIEW_BUDGET_MS;
	try {
		for (const [owner, ownedFiles] of groupFiles(files, owners)) {
			const answer = [
				...new Set([
					...[...store.writers()].flatMap(([module, writer]) => (writer === owner ? [module] : [])),
					...files.flatMap((file) => (owners.get(file.module)?.id === owner ? [file.module] : [])),
				]),
			];
			const reply = await prepare(probe, owner, files, answer);
			if (reply.status !== "ready") {
				const reason = reply.status === "unknown" ? reply.reason : "provider";
				return baseline
					.filter((cycle) => cycle.modules.some((module) => files.some((file) => file.module === module)))
					.slice(0, MAX_PREVIEWS)
					.map((cycle) => unknown(cycle, reason));
			}
			const incarnation = owners.get(ownedFiles[0]!.module)!.incarnation;
			tokens.push({ owner, incarnation, token: reply.preview });
			const expectedFingerprint = ownedFiles.map((file) => owners.get(file.module)?.fingerprint)[0];
			if (
				reply.settings.length !== 1 ||
				reply.settings[0]?.project !== owner ||
				reply.settings[0]?.fingerprint !== expectedFingerprint
			)
				return [];
			prepared.push({
				owner,
				incarnation,
				token: reply.preview,
				facts: inputOf(owner, reply),
				response: reply,
			});
		}
		if (!baselineStillHolds(store, providers, files, bases, owners, revision)) return [];
		const overlaid = prepared.flatMap((item) => item.facts);
		const candidateView = await gate.write(() => {
			if (!baselineStillHolds(store, providers, files, bases, owners, revision)) return undefined;
			const cycles = previewComponents(store, overlaid);
			const evidenceBases = new Map<string, string | null>();
			for (const module of cycles.flatMap((cycle) => cycle.modules))
				evidenceBases.set(module, store.contentHashOf(module));
			return { cycles, evidenceBases };
		});
		if (candidateView === undefined) return [];
		const { evidenceBases } = candidateView;
		const fresh = newCycleComponents(candidateView.cycles, baseline).slice(0, MAX_PREVIEWS);
		const result: Array<{ cycle: Cycle; judgment: PreviewJudgment }> = [];
		for (const cycle of fresh) {
			if (clock.now() >= expiry) {
				result.push({ cycle, judgment: { result: unknown(cycle, "budget") } });
				continue;
			}
			const providersForCycle = new Set(
				cycle.modules
					.map((module) => owners.get(module)?.id ?? store.writerOf(module))
					.filter((id): id is string => id !== null),
			);
			if (providersForCycle.size !== 1) {
				result.push({ cycle, judgment: { result: unknown(cycle, "provider") } });
				continue;
			}
			const owner = [...providersForCycle][0];
			if (owner === undefined) {
				result.push({ cycle, judgment: { result: unknown(cycle, "provider") } });
				continue;
			}
			const context = prepared.find((item) => item.owner === owner);
			if (context === undefined) {
				result.push({ cycle, judgment: { result: unknown(cycle, "provider") } });
				continue;
			}
			const changed = hashes(store, files);
			const members = cycle.modules.map((module) => ({
				module,
				contentHash: changed.get(module) ?? store.contentHashOf(module) ?? "",
			}));
			if (members.some((member) => member.contentHash === "")) {
				result.push({ cycle, judgment: { result: unknown(cycle, "evidence") } });
				continue;
			}
			result.push({
				cycle,
				judgment: await judge(
					providers,
					cycle,
					context.token,
					members,
					owner,
					context.incarnation,
					context.response.settings[0]!.fingerprint,
				),
			});
		}
		const revalidated = await gate.write(() => {
			if (
				!baselineStillHolds(store, providers, files, bases, owners, revision) ||
				result.some(({ cycle }) =>
					cycle.modules.some((module) => store.contentHashOf(module) !== evidenceBases.get(module)),
				) ||
				files.some((file) => store.contentHashOf(file.module) !== bases.get(file.module))
			)
				return [];
			return withPreviewComponents(store, overlaid, (latest) => {
				const validKeys = new Set(newCycleComponents(latest, baseline).map((cycle) => cycle.key));
				return result.flatMap(({ cycle, judgment }) => {
					if (!validKeys.has(cycle.key)) return [];
					if (judgment.evidence !== undefined && !landingsHold(store, judgment.evidence))
						return [unknown(cycle, "evidence")];
					return [judgment.result];
				});
			});
		});
		return revalidated;
	} catch {
		return [];
	} finally {
		for (const item of tokens) {
			providers.releaseLoadCyclePreview(item.owner, item.incarnation, item.token);
		}
	}
}

function groupFiles(
	files: readonly ArrangeFile[],
	owners: ReadonlyMap<string, { id: string; incarnation: number; fingerprint: string | null }>,
): Map<string, ArrangeFile[]> {
	const groups = new Map<string, ArrangeFile[]>();
	for (const file of files) {
		const owner = owners.get(file.module)?.id;
		if (owner === undefined) continue;
		const group = groups.get(owner) ?? [];
		group.push(file);
		groups.set(owner, group);
	}
	return groups;
}
