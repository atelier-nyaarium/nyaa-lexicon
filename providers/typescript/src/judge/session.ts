// Judging one load-order component, in slices, against the Program its first slice pinned.

import { randomUUID } from "node:crypto";
import {
	hashContent,
	type IndexAdmission,
	type JudgeLoadCycleAnswer,
	type JudgeLoadCycleRequest,
	type LoadCycleHazard,
} from "@nyaa-lexicon/protocol";
import type { TypeScriptProject } from "../module.js";
import { BudgetExceeded, type Finding, HOLD_MS, MAX_ENTRIES, SLICE_MS, type UnknownNote } from "./model.js";
import { preparedPreview } from "./preview.js";
import { PinnedProgram, type Resolve } from "./program.js";
import { Walker } from "./walker.js";
import { scanWrites, type Writes } from "./writes.js";

////////////////////////////////
//  Interfaces & Types

type Answered = Extract<JudgeLoadCycleAnswer, { verdict: unknown }>;

type Settings = Answered["settings"];

/** A judgment between slices: its work, and when it last ran. */
export interface JudgeSession {
	readonly key: string;
	readonly preview?: string;
	readonly work: Generator<undefined, Answered, undefined>;
	lastSlice: number;
}

export interface JudgeHost {
	readonly providerId: string;
	readonly resolve: Resolve;
	readonly surface: (module: string) => boolean;
	/** Whether the index holds a module, may yet, or never reads it, for what evidence lists. */
	readonly admission: (module: string) => IndexAdmission;
	/** How long one slice works; the default outside tests. */
	readonly sliceMs?: number;
}

////////////////////////////////
//  Constants

/** Hazards and unknowns one answer lists at most. */
const LISTED = 100;

////////////////////////////////
//  Functions & Helpers

function unknownAnswer(
	request: JudgeLoadCycleRequest,
	reason: UnknownNote["reason"],
	settings: Settings,
	module?: string,
): Answered {
	return {
		...(request.preview === undefined ? {} : { preview: request.preview }),
		verdict: "unknown",
		bad: [],
		unknowns: [{ ...(module === undefined ? {} : { module }), reason }],
		evidence: request.members.map((member) => ({ ...member, landings: [] })),
		settings,
	};
}

function distinct<T>(items: readonly T[]): T[] {
	const seen = new Set<string>();
	return items.filter((item) => {
		const key = JSON.stringify(item);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/**
 * What the index holds or will: each module it admitted or may yet, and what an import reaches from
 * one, as its own import walk follows. The rest are outside it.
 */
function* indexHeld(
	pinned: PinnedProgram,
	writes: Writes | undefined,
	admission: (module: string) => IndexAdmission,
	modules: readonly string[],
): Generator<undefined, Set<string>, undefined> {
	const held = new Set<string>();
	const outside = new Set<string>();
	for (const module of modules) {
		if (admission(module).state === "outside") outside.add(module);
		else held.add(module);
	}
	// Imports matter only for reaching a module outside.
	const pending = outside.size === 0 ? [] : [...held];
	for (let module = pending.pop(); module !== undefined; module = pending.pop()) {
		yield;
		for (const specifier of writes?.imports.get(module) ?? []) {
			const target = pinned.target(module, specifier);
			if (target === null || held.has(target)) continue;
			held.add(target);
			pending.push(target);
		}
	}
	return held;
}

/** Every entry walked in turn, then the evidence the walks and the writes scan read. */
function* judgeWork(
	pinned: PinnedProgram,
	request: JudgeLoadCycleRequest,
	settings: Settings,
	scanned: WeakMap<object, Writes>,
	admission: (module: string) => IndexAdmission,
): Generator<undefined, Answered, undefined> {
	const members = request.members.map((member) => member.module);
	for (const member of request.members) {
		const source = pinned.sourceOf(member.module);
		if (source === undefined || hashContent(source.text) !== member.contentHash)
			return unknownAnswer(request, "evidence", settings, member.module);
		pinned.touch(member.module);
	}
	const runtimes = new Set(members.map((module) => pinned.runtime(module)));
	const [runtime] = runtimes;
	if (runtimes.size !== 1 || runtime === undefined) return unknownAnswer(request, "runtime", settings);
	if (new Set(members.map((module) => pinned.group(module))).size !== 1)
		return unknownAnswer(request, "model", settings);
	const findings: Array<Finding & { order: string[] }> = [];
	const notes: UnknownNote[] = [];
	let writes: Writes | undefined;
	try {
		writes = scanned.get(pinned.program) ?? (yield* scanWrites(pinned));
		scanned.set(pinned.program, writes);
		const budget = { steps: 0 };
		for (const entry of request.entries) {
			const walker = new Walker(pinned, writes, new Set(members), entry, runtime, budget);
			yield* walker.run();
			findings.push(...walker.findings.map((finding) => ({ ...finding, order: [...walker.order] })));
			notes.push(...walker.notes);
		}
	} catch (error) {
		// A chain of loads deeper than the stack is past the budget too.
		if (error instanceof BudgetExceeded || error instanceof RangeError)
			return unknownAnswer(request, "budget", settings);
		// The checker asserts on some code it cannot bind; that code is outside the model.
		if (error instanceof Error && error.message.startsWith("Debug Failure"))
			return unknownAnswer(request, "model", settings);
		throw error;
	}
	const read: Answered["evidence"] = [];
	for (const row of pinned.evidence()) {
		read.push(row);
		yield;
	}
	const scan = writes?.sources ?? [];
	const held = yield* indexHeld(
		pinned,
		writes,
		admission,
		[...read, ...scan].map((row) => row.module),
	);
	// A module outside the index stays out, like a library's (rule 8a); members are always in.
	const evidence = read.filter((row) => held.has(row.module) || members.includes(row.module));
	// "Nothing assigns it" is a fact about every module the writes scan read.
	const listed = new Set(evidence.map((row) => row.module));
	for (const { module, contentHash } of scan) {
		if (!listed.has(module) && held.has(module)) evidence.push({ module, contentHash, landings: [] });
	}
	const bad: LoadCycleHazard[] = distinct(
		findings.map(({ entry, order, reader, target, calls }) => ({
			entry,
			order,
			reader,
			target,
			calls: [...calls],
		})),
	).slice(0, LISTED);
	const unknowns = distinct(notes).slice(0, LISTED);
	return {
		...(request.preview === undefined ? {} : { preview: request.preview }),
		verdict: bad.length > 0 ? "bad" : unknowns.length > 0 ? "unknown" : "fine",
		bad,
		unknowns,
		evidence,
		settings,
	};
}

/** Works about one slice's time, then answers or holds the work under its token. */
function slice(
	sessions: Map<string, JudgeSession>,
	token: string,
	session: JudgeSession,
	sliceMs: number,
): JudgeLoadCycleAnswer {
	const deadline = performance.now() + sliceMs;
	try {
		for (;;) {
			const next = session.work.next();
			if (next.done === true) {
				sessions.delete(token);
				return next.value;
			}
			if (performance.now() >= deadline) {
				session.lastSlice = Date.now();
				sessions.set(token, session);
				return { ...(session.preview === undefined ? {} : { preview: session.preview }), partial: token };
			}
		}
	} catch (error) {
		sessions.delete(token);
		throw error;
	}
}

////////////////////////////////
//  Main

/**
 * One slice of a judgment. The first pins the Program indexing holds; a continuation resumes the
 * work its token names, until it answers or its held state expires.
 */
export function judgeLoadCycle(
	project: TypeScriptProject | undefined,
	host: JudgeHost,
	request: JudgeLoadCycleRequest,
): JudgeLoadCycleAnswer {
	if (project === undefined) return unknownAnswer(request, "notReady", []);
	const sessions = project.judgments;
	const now = Date.now();
	for (const [token, held] of sessions) if (now - held.lastSlice > HOLD_MS) sessions.delete(token);
	const prepared = request.preview === undefined ? undefined : preparedPreview(project, request.preview, now);
	if (request.preview !== undefined && prepared === undefined) return unknownAnswer(request, "evidence", []);
	const settings = prepared?.settings ?? [{ project: host.providerId, fingerprint: project.fingerprint }];
	const key = JSON.stringify([request.preview ?? null, request.members, request.entries]);
	if (request.partial !== undefined) {
		const held = sessions.get(request.partial);
		if (held === undefined || held.key !== key) return unknownAnswer(request, "budget", settings);
		return slice(sessions, request.partial, held, host.sliceMs ?? SLICE_MS);
	}
	if (request.entries.length > MAX_ENTRIES) return unknownAnswer(request, "budget", settings);
	const analyzer = prepared?.analyzer ?? project.analyzer;
	const first = request.members[0]?.module;
	if (analyzer === undefined || analyzer.cold() || first === undefined)
		return unknownAnswer(request, "notReady", settings);
	const program = prepared?.programs.get(analyzer.groupOf(first)) ?? analyzer.programOf(first);
	if (program === undefined) return unknownAnswer(request, "notReady", settings);
	const pinned = new PinnedProgram({
		root: project.root,
		loaded: project.loaded,
		program,
		resolve: prepared?.host.resolve ?? host.resolve,
		surface: prepared?.host.surface ?? host.surface,
		group: (module) => analyzer.groupOf(module),
	});
	const work = judgeWork(pinned, request, settings, project.writes, prepared?.host.admission ?? host.admission);
	const session: JudgeSession = {
		key,
		...(request.preview === undefined ? {} : { preview: request.preview }),
		work,
		lastSlice: now,
	};
	return slice(sessions, randomUUID(), session, host.sliceMs ?? SLICE_MS);
}

/** Drops the work a partial token holds. */
export function releaseLoadCycle(project: TypeScriptProject | undefined, token: string): void {
	project?.judgments.delete(token);
}
