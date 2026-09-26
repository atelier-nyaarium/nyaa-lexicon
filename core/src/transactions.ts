// The refactor journal: the one module that reads or writes the refactor_ tables.
//
// A residue test holds that ownership, because the journal is the only record of what a
// half-applied refactor used to look like. A second writer that got a phase transition slightly
// wrong would not corrupt a query, it would lose the ability to put files back.
//
// Files are snapshotted as raw bytes. A source file that is not valid UTF-8 still has to come back
// byte-identical, and hashing decoded text would let two different files share an image.

import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readFileSync,
	readlinkSync,
	rmSync,
	type Stats,
} from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import {
	type CommittedFile,
	hashBytes,
	type LedgerMark,
	MAX_SOURCE_BYTES,
	moduleOf,
	type RefactorBeforeImage,
	type RefactorIssue,
	type RefactorSettledImage,
	type RefactorSettlements,
	resolveContained,
	type StepBase,
	type StepKind,
	type StepPhase,
	type TransactionStatus,
} from "@nyaa-lexicon/protocol";
import { systemClock } from "./clock.js";
import { SETTLEMENTS_KEPT } from "./journalSchema.js";
import type {
	CommittedTransaction,
	NotedFileWrite,
	RevertedTransaction,
	StartedTransaction,
	TrackedFile,
	UndoneStep,
	WrittenFile,
} from "./refusalSlots.js";
import {
	directoryInTheWay,
	noTransactionOpen,
	notARegularFile,
	notedWriteDoesNotMatch,
	nothingToUndo,
	type Refusal,
	recoveryPending,
	refactorChangedSinceShown,
	refactorDriftChangedSinceShown,
	refactorPathLeavesWorkspace,
	stepOutsideBases,
	transactionAlreadyOpen,
	undoWouldDiscard,
	unresolvedIssues,
	writeChanged,
	writeLeavesWorkspace,
	writeNotTracked,
	writeOverDirectory,
	writeOverNonFile,
	writeTooLarge,
} from "./refusals.js";
import { sweepTemporary, writeSourceFile } from "./sourceWriter.js";
import type { IndexStore } from "./store.js";
import type { AppliedRebind, KeptRebind, RebindEntry, RebindEvidence, RebindResult } from "./subjects.js";

export type { RefactorIssue, StepKind, StepPhase, TransactionStatus, TransactionStep } from "@nyaa-lexicon/protocol";

import { insideWorkspace, writableText } from "./sourceRead.js";

////////////////////////////////
//  Interfaces & Types

/** Where a snapshot belongs. The baseline is what revert restores; a step image is what undo does. */
export type ImageScope = "baseline" | "step";

/** What a file looked like, and whether it was there at all. Absent and empty are different. */
export interface FileImage {
	module: string;
	existed: boolean;
	hash: string | null;
}

type Foreign = "link" | "directory" | "special";

type PathState = FileImage | { module: string; foreign: Foreign };

type DiskState =
	| { module: string; kind: "file"; hash: string }
	| { module: string; kind: "missing" }
	| { module: string; kind: "link"; target: string }
	| { module: string; kind: "directory" }
	| { module: string; kind: "special"; identity: string }
	| { module: string; kind: "outside" };

interface KnownFileState {
	module: string;
	existed: boolean;
	hash: string | null;
	edited: boolean;
}

/** Status token used by refactor requests. See `docs/daemon-protocol.md` `expect`. */
export interface Expectation {
	id: string;
	revision: number;
}

export type StepOutcome = { ok: true; stepNo: number } | { ok: false; reason: Refusal; unexpected?: StepBase[] };

type RecoveryIntent = {
	operation: "undo" | "revert";
	stepNo: number | null;
	diskStates: DiskState[] | null;
};

/** `explicit` from `refactor_start`, `own` from a step that opens its own. */
export type TransactionOrigin = "explicit" | "own";

export interface Recovered {
	recovered: boolean;
	transactionId?: string;
	restored: string[];
	conflicts: string[];
	unreversed: KeptRebind[];
	/** How recovery closed an `own` transaction. */
	closed?: "committed" | "reverted";
}

////////////////////////////////
//  Functions & Helpers

/** No-follow and nonblocking flags protect against link and FIFO swaps. */
const OPEN_LEAF = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

function lstatOf(full: string): Stats | null {
	try {
		return lstatSync(full);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return null;
		throw error;
	}
}

function foreignOf(found: Stats): Foreign | null {
	if (found.isSymbolicLink()) return "link";
	if (found.isDirectory()) return "directory";
	return found.isFile() ? null : "special";
}

/** Reads regular files without following links. */
export function readLeaf(
	full: string,
	openFile: (path: string, flags: number) => number = openSync,
): { kind: "missing" } | { kind: "file"; bytes: Buffer } | { kind: Foreign } {
	const found = lstatOf(full);
	if (found === null) return { kind: "missing" };
	const foreign = foreignOf(found);
	if (foreign !== null) return { kind: foreign };

	let fd: number;
	try {
		fd = openFile(full, OPEN_LEAF);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { kind: "missing" };
		if (code === "ELOOP") return { kind: "link" };
		throw error;
	}
	try {
		const openedStats = fstatSync(fd);
		const opened = foreignOf(openedStats);
		if (opened === null && (openedStats.dev !== found.dev || openedStats.ino !== found.ino))
			return { kind: "link" };
		return opened === null ? { kind: "file", bytes: readFileSync(fd) } : { kind: opened };
	} finally {
		closeSync(fd);
	}
}

/** Text requires UTF-8 and no NUL in the first 8 KiB. */
function encoded(
	contentHash: string,
	bytes: Uint8Array,
):
	| { contentHash: string; encoding: "text"; text: string }
	| { contentHash: string; encoding: "base64"; bytes: string } {
	const text = Buffer.from(bytes).toString("utf8");
	const roundTrips = Buffer.from(text, "utf8").equals(Buffer.from(bytes));
	if (roundTrips && !bytes.subarray(0, 8192).includes(0)) return { contentHash, encoding: "text", text };
	return { contentHash, encoding: "base64", bytes: Buffer.from(bytes).toString("base64") };
}

function holds(current: PathState, existed: boolean, hash: string | null): boolean {
	return !("foreign" in current) && current.existed === existed && current.hash === hash;
}

function sameDrift(left: Array<{ module: string; contentHash: string | null }>, right: typeof left): boolean {
	const expected = new Map(left.map(({ module, contentHash }) => [module, contentHash]));
	const actual = new Map(right.map(({ module, contentHash }) => [module, contentHash]));
	return (
		expected.size === left.length &&
		actual.size === right.length &&
		expected.size === actual.size &&
		[...expected].every(([module, hash]) => actual.get(module) === hash)
	);
}

function sameDiskState(left: DiskState, right: DiskState): boolean {
	if (left.module !== right.module || left.kind !== right.kind) return false;
	switch (left.kind) {
		case "file":
			return right.kind === "file" && left.hash === right.hash;
		case "link":
			return right.kind === "link" && left.target === right.target;
		case "special":
			return right.kind === "special" && left.identity === right.identity;
		default:
			return true;
	}
}

function diskStateHoldsImage(state: DiskState, existed: boolean, hash: string | null): boolean {
	return existed ? state.kind === "file" && state.hash === hash : state.kind === "missing";
}

function parseDiskStates(raw: string | null): DiskState[] | null {
	if (raw === null) return null;
	try {
		const value: unknown = JSON.parse(raw);
		if (!Array.isArray(value)) return null;
		for (const state of value) {
			if (typeof state !== "object" || state === null || typeof state.module !== "string") return null;
			switch (state.kind) {
				case "file":
					if (typeof state.hash !== "string") return null;
					break;
				case "missing":
				case "directory":
				case "outside":
					break;
				case "link":
					if (typeof state.target !== "string") return null;
					break;
				case "special":
					if (typeof state.identity !== "string") return null;
					break;
				default:
					return null;
			}
		}
		return value as DiskState[];
	} catch {
		return null;
	}
}

////////////////////////////////
//  Class

/**
 * Owns refactor state transitions for one workspace.
 * Gate ownership follows `WorkspaceGate` in `docs/architecture.md`.
 */
export class TransactionManager {
	constructor(
		private readonly store: IndexStore,
		private readonly workspaceRoot: string,
		private readonly now: () => number = () => systemClock.now(),
		private readonly failAfterRestore?: () => void,
	) {}

	////////////////////////////////
	//  Lifecycle

	/** Opens the workspace transaction. See `docs/daemon-protocol.md` `refactorStart`. */
	start(origin: TransactionOrigin = "explicit"): StartedTransaction {
		const open = this.openTransaction();
		if (open) return { started: false, id: open.id, reason: transactionAlreadyOpen() };

		const id = `rt-${this.now().toString(36)}-${Math.trunc(Math.random() * 0xfffff).toString(36)}`;
		this.store.journalWrite((db) => {
			db.prepare("INSERT INTO refactor_transactions (id, state, startedAt, origin) VALUES (?, ?, ?, ?)").run(
				id,
				"open",
				this.now(),
				origin,
			);
		});
		return { started: true, id };
	}

	/** Reads open transaction state. See `docs/daemon-protocol.md` `refactorStatus`. */
	openTransaction(): { id: string; startedAt: number; origin: TransactionOrigin; revision: number } | null {
		const row = this.store.journalRead((db) =>
			db.prepare("SELECT id, startedAt, origin, revision FROM refactor_transactions WHERE state = 'open'").get(),
		) as { id: string; startedAt: number; origin: TransactionOrigin | null; revision: number } | undefined;
		// A null origin means explicit.
		return row === undefined
			? null
			: { id: row.id, startedAt: row.startedAt, origin: row.origin ?? "explicit", revision: row.revision };
	}

	/** Records the opening image. See `docs/architecture.md` Refactor transactions. */
	track(module: string): TrackedFile {
		const ledger = this.ledger();
		const open = this.openTransaction();
		if (!open) return { tracked: false, refactor: null, ledger, reason: noTransactionOpen() };

		const refactor = { id: open.id };
		if (this.imageFor(open.id, "baseline", 0, module)) return { tracked: true, refactor, ledger };
		const image = this.snapshot(module);
		if ("foreign" in image)
			return { tracked: false, refactor, ledger, reason: notARegularFile(module, image.foreign) };
		this.claimBaseline(open.id, image);
		return { tracked: true, refactor, ledger };
	}

	/** Applies an editor state note. See `docs/daemon-protocol.md` `refactorNoteWrite`. */
	noteWrite(module: string, state: { contentHash: string } | { absent: true }): NotedFileWrite {
		const open = this.openTransaction();
		if (!open) return { noted: false, reason: noTransactionOpen() };

		const known = this.knownState(open.id, module);
		if (!known) return { noted: false, reason: writeNotTracked(module) };

		const expected =
			"absent" in state
				? { module, existed: false, hash: null }
				: { module, existed: true, hash: state.contentHash };
		const current = this.observe(module);
		if (!diskStateHoldsImage(current.state, expected.existed, expected.hash)) {
			return { noted: false, reason: notedWriteDoesNotMatch(module) };
		}

		this.noteKnown(open.id, module, expected.hash, current.bytes);
		return { noted: true };
	}

	/** Gated write or delete. */
	writeFile(
		module: string,
		content: { text: string } | { bytes: Uint8Array } | null,
		expect: string | null,
	): WrittenFile {
		if (content !== null && "text" in content) {
			const unencodable = writableText(module, content.text);
			if (unencodable !== null) return { written: false, refused: "unencodable", reason: unencodable };
		}
		const bytes = content === null ? null : "text" in content ? Buffer.from(content.text, "utf8") : content.bytes;
		if (bytes !== null && bytes.length > MAX_SOURCE_BYTES) {
			return {
				written: false,
				refused: "tooLarge",
				reason: writeTooLarge(module, bytes.length, MAX_SOURCE_BYTES),
			};
		}

		// Leaf links can escape.
		const full = this.contained(module);
		if (full === null || resolveContained(this.workspaceRoot, module).kind === "outside") {
			return { written: false, refused: "outside", reason: writeLeavesWorkspace(module) };
		}
		const leaf = readLeaf(full);
		if (leaf.kind === "directory")
			return { written: false, refused: "directory", reason: writeOverDirectory(module) };
		if (leaf.kind === "link" || leaf.kind === "special") {
			return { written: false, refused: "notAFile", reason: writeOverNonFile(module, leaf.kind) };
		}
		const current = leaf.kind === "file" ? hashBytes(leaf.bytes) : null;
		if (current !== expect) {
			return { written: false, refused: "changed", reason: writeChanged(module, current), contentHash: current };
		}

		const open = this.openTransaction();
		if (open !== null) {
			// Journal before writing.
			const tracked = this.track(module);
			if (!tracked.tracked) throw new Error(tracked.reason ?? `${module} could not be tracked`);
		}
		if (bytes === null) rmSync(full, { force: true });
		else writeSourceFile(full, bytes);
		const contentHash = bytes === null ? null : hashBytes(bytes);
		if (open !== null) this.noteKnown(open.id, module, contentHash, bytes);
		return {
			written: true,
			contentHash,
			refactor: open === null ? null : { id: open.id },
			ledger: this.ledger(),
		};
	}

	/** Keeps known bytes for settlement. */
	private noteKnown(transactionId: string, module: string, hash: string | null, bytes: Uint8Array | null): void {
		this.store.journalWrite((db) => {
			if (hash !== null && bytes !== null) this.store.putBlob(hash, bytes);
			db.prepare(
				"UPDATE refactor_known_states SET existed = ?, contentHash = ?, edited = 1 WHERE transactionId = ? AND module = ?",
			).run(hash === null ? 0 : 1, hash, transactionId, module);
		});
	}

	/** Reads the opening image. See `docs/daemon-protocol.md` `refactorBeforeImage`. */
	beforeImage(module: string, id?: string): RefactorBeforeImage {
		const open = this.openTransaction();
		if (!open || (id !== undefined && id !== open.id)) return { tracked: false };

		const image = this.store.journalRead((db) =>
			db
				.prepare(
					"SELECT existedBefore, beforeHash FROM refactor_images WHERE transactionId = ? AND scope = 'baseline' AND stepNo = 0 AND module = ?",
				)
				.get(open.id, module),
		) as { existedBefore: number; beforeHash: string | null } | undefined;
		if (image === undefined) return { tracked: false };
		if (image.existedBefore === 0) return { tracked: true, existed: false };

		const contentHash = image.beforeHash;
		if (contentHash === null) throw new Error(`tracked baseline has no content hash: ${module}`);
		const bytes = this.store.blob(contentHash);
		if (bytes === null) throw new Error(`tracked baseline bytes are missing: ${module}`);
		return { tracked: true, existed: true, ...encoded(contentHash, bytes) };
	}

	ledger(): LedgerMark {
		const row = this.store.journalRead((db) =>
			db.prepare("SELECT MAX(seq) AS latest FROM refactor_settlements").get(),
		) as { latest: number | null };
		return { id: this.store.refactorLedgerId(), latest: row.latest ?? 0 };
	}

	settlements(after: number, limit = 16): RefactorSettlements {
		return this.store.journalRead((db) => {
			const bounds = db
				.prepare("SELECT MIN(seq) AS oldest, MAX(seq) AS latest FROM refactor_settlements")
				.get() as {
				oldest: number | null;
				latest: number | null;
			};
			const rows = db
				.prepare(
					"SELECT seq, transactionId, origin, outcome, closedAt FROM refactor_settlements WHERE seq > ? ORDER BY seq LIMIT ?",
				)
				.all(after, limit) as Array<{
				seq: number;
				transactionId: string;
				origin: "explicit" | "own";
				outcome: "committed" | "reverted";
				closedAt: number;
			}>;
			const filesOf = db.prepare(
				"SELECT module, opened, settled, drifted, driftedHash FROM refactor_settled_files WHERE seq = ? ORDER BY module",
			);
			return {
				ledger: { id: this.store.refactorLedgerId(), latest: bounds.latest ?? 0 },
				oldest: bounds.oldest,
				settlements: rows.map((row) => ({
					seq: row.seq,
					id: row.transactionId,
					origin: row.origin,
					outcome: row.outcome,
					closedAt: row.closedAt,
					files: (
						filesOf.all(row.seq) as Array<{
							module: string;
							opened: string | null;
							settled: string | null;
							drifted: number;
							driftedHash: string | null;
						}>
					).map((file) => ({
						module: file.module,
						opened: file.opened,
						settled: file.settled,
						...(file.drifted === 1 ? { drifted: { contentHash: file.driftedHash } } : {}),
					})),
				})),
			};
		});
	}

	settledImage(seq: number, module: string, side: "opened" | "settled"): RefactorSettledImage {
		const row = this.store.journalRead((db) =>
			db
				.prepare("SELECT opened, settled FROM refactor_settled_files WHERE seq = ? AND module = ?")
				.get(seq, module),
		) as { opened: string | null; settled: string | null } | undefined;
		if (row === undefined) return { held: false };
		const hash = row[side];
		if (hash === null) return { held: true, absent: true };
		const bytes = this.store.blob(hash);
		return bytes === null ? { held: false } : { held: true, ...encoded(hash, bytes) };
	}

	/** Reads transaction state. See `docs/daemon-protocol.md` `refactorStatus`. */
	status(): TransactionStatus {
		const ledger = this.ledger();
		const open = this.openTransaction();
		if (!open) return { open: false, steps: [], tracked: [], drifted: [], edited: [], issues: [], ledger };

		const steps = this.store.journalRead((db) =>
			db
				.prepare("SELECT stepNo, kind, phase FROM refactor_steps WHERE transactionId = ? ORDER BY stepNo")
				.all(open.id),
		) as Array<{ stepNo: number; kind: StepKind; phase: StepPhase }>;

		const images = this.store.journalRead((db) =>
			db.prepare("SELECT scope, stepNo, module FROM refactor_images WHERE transactionId = ?").all(open.id),
		) as Array<{ scope: ImageScope; stepNo: number | null; module: string }>;
		const known = this.knownStates(open.id);
		const observed = this.observeKnownStates(open.id, known);
		const tracked = [
			...new Set(images.filter((image) => image.scope === "baseline").map((image) => image.module)),
		].sort();

		return {
			open: true,
			id: open.id,
			startedAt: open.startedAt,
			revision: open.revision,
			steps: steps.map((step) => ({
				...step,
				modules: images
					.filter((image) => image.scope === "step" && image.stepNo === step.stepNo)
					.map((i) => i.module),
			})),
			tracked,
			drifted: observed.drifted,
			edited: known
				.filter((state) => state.edited)
				.map((state) => state.module)
				.sort(),
			issues: this.issues(open.id),
			ledger,
		};
	}

	issues(transactionId: string): RefactorIssue[] {
		const rows = this.store.journalRead((db) =>
			db
				.prepare(
					"SELECT stepNo, kind, detail, module, line FROM refactor_issues WHERE transactionId = ? ORDER BY stepNo",
				)
				.all(transactionId),
		) as Array<{ stepNo: number; kind: string; detail: string; module: string | null; line: number | null }>;

		return rows.map((row) => ({
			kind: row.kind,
			detail: row.detail,
			stepNo: row.stepNo,
			...(row.module === null ? {} : { module: row.module }),
			...(row.line === null ? {} : { line: row.line }),
		}));
	}

	////////////////////////////////
	//  Steps

	/** Journals step images. See `docs/architecture.md` Refactor transactions. */
	beginStep(
		kind: StepKind,
		modules: string[],
		plan?: unknown,
		plannedText?: Array<{ module: string; text: string }>,
		expect?: { writes: string[]; bases: StepBase[] },
	): StepOutcome {
		const open = this.openTransaction();
		if (!open) return { ok: false, reason: noTransactionOpen() };

		const stepNo = this.nextStepNo(open.id);
		const images: FileImage[] = [];
		for (const module of modules) {
			const image = this.snapshot(module);
			if ("foreign" in image) return { ok: false, reason: notARegularFile(module, image.foreign) };
			images.push(image);
		}

		if (expect !== undefined) {
			const shown = new Map(expect.bases.map((base) => [base.module, base.contentHash]));
			const unexpected = images
				.filter((image) => expect.writes.includes(image.module))
				.filter((image) => !shown.has(image.module) || shown.get(image.module) !== image.hash)
				.map((image) => ({ module: image.module, contentHash: image.hash }));
			if (unexpected.length > 0) {
				return { ok: false, reason: stepOutsideBases(unexpected.map((base) => base.module)), unexpected };
			}
		}

		this.store.journalWrite((db) => {
			db.prepare(
				"INSERT INTO refactor_steps (transactionId, stepNo, kind, phase, plan, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
			).run(open.id, stepNo, kind, "journaled", plan === undefined ? null : JSON.stringify(plan), this.now());
		});

		for (const image of images) {
			// Give every step-touched module a baseline for Revert.
			if (!this.imageFor(open.id, "baseline", 0, image.module)) this.claimBaseline(open.id, image);
			const known = this.knownState(open.id, image.module);
			const beforeEdited = known !== null && known.edited && holds(image, known.existed, known.hash);
			// Store a known output hash before a write so recovery can identify its result.
			const planned = plannedText?.find((entry) => entry.module === image.module);
			this.writeImage(
				open.id,
				"step",
				stepNo,
				image,
				planned === undefined
					? undefined
					: { module: image.module, existed: true, hash: hashBytes(Buffer.from(planned.text, "utf8")) },
				beforeEdited,
			);
		}

		return { ok: true, stepNo };
	}

	/** Records step output. See `docs/architecture.md` Refactor transactions. */
	completeStep(stepNo: number, phase: StepPhase): void {
		const open = this.openTransaction();
		if (!open) return;

		if (phase === "written") {
			const modules = this.modulesOf(open.id, stepNo);
			for (const module of modules) {
				// Non-file paths have unknown after-images.
				const after = this.snapshot(module);
				const existsAfter = "foreign" in after || after.existed ? 1 : 0;
				const afterHash = "foreign" in after ? null : after.hash;
				this.store.journalWrite((db) => {
					db.prepare(
						`UPDATE refactor_images SET existsAfter = ?, afterHash = ?
						 WHERE transactionId = ? AND scope = 'step' AND stepNo = ? AND module = ?`,
					).run(existsAfter, afterHash, open.id, stepNo, module);
					if (!("foreign" in after)) {
						this.writeKnownState(db, open.id, module, after.existed, after.hash, false);
					}
				});
			}
		}

		this.store.journalWrite((db) => {
			db.prepare("UPDATE refactor_steps SET phase = ? WHERE transactionId = ? AND stepNo = ?").run(
				phase,
				open.id,
				stepNo,
			);
		});
	}

	/** Journals subject moves. See `core/src/subjects.ts` `rebindBack`. */
	rebind(stepNo: number, entries: RebindEntry[], evidence: RebindEvidence): RebindResult {
		const open = this.openTransaction();
		if (!open) throw new Error("no refactor transaction is open");
		return this.store.journalWrite((db) => {
			const result = this.store.subjects.rebind(entries, evidence, this.now());
			const next = (
				db
					.prepare(
						"SELECT COALESCE(MAX(ordinal), -1) + 1 AS next FROM refactor_rebinds WHERE transactionId = ? AND stepNo = ?",
					)
					.get(open.id, stepNo) as { next: number }
			).next;
			const insert = db.prepare(
				`INSERT INTO refactor_rebinds
				 (transactionId, stepNo, ordinal, subjectId, fromSymbolId, toSymbolId,
				  priorFrom, priorEvidence, priorBoundAt, priorState, priorOrphanedAt)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			result.applied.forEach((move, index) => {
				insert.run(
					open.id,
					stepNo,
					next + index,
					move.subjectId,
					move.from,
					move.to,
					move.priorFrom,
					move.priorEvidence,
					move.priorBoundAt,
					move.priorState,
					move.priorOrphanedAt,
				);
			});
			return result;
		});
	}

	/** A step's modules and hashes; gone after commit. */
	stepFiles(stepNo: number): CommittedFile[] {
		const open = this.openTransaction();
		if (!open) return [];
		return this.imagesOf(open.id, "step", stepNo)
			.map((image) => ({ module: image.module, before: image.beforeHash, after: image.afterHash }))
			.sort((left, right) => (left.module < right.module ? -1 : left.module > right.module ? 1 : 0));
	}

	recordIssues(stepNo: number, issues: RefactorIssue[]): void {
		const open = this.openTransaction();
		if (!open || issues.length === 0) return;

		this.store.journalWrite((db) => {
			const insert = db.prepare(
				"INSERT INTO refactor_issues (transactionId, stepNo, kind, detail, module, line) VALUES (?, ?, ?, ?, ?, ?)",
			);
			for (const issue of issues) {
				insert.run(open.id, stepNo, issue.kind, issue.detail, issue.module ?? null, issue.line ?? null);
			}
		});
	}

	////////////////////////////////
	//  Unwinding

	/** Restores the newest step. See `docs/architecture.md` Refactor transactions. */
	undo(expect?: Expectation): UndoneStep {
		const open = this.openTransaction();
		if (!this.asShown(open, expect)) return { undone: false, reason: refactorChangedSinceShown() };
		if (!open) return { undone: false, reason: noTransactionOpen() };
		const intent = this.recoveryIntent(open.id);
		if (intent !== null) {
			if (intent.operation !== "undo" || intent.stepNo === null)
				return { undone: false, reason: recoveryPending(intent.operation) };
			const pending = this.imagesOf(open.id, "step", intent.stepNo);
			const blocked = this.directoriesAt(pending);
			if (blocked.length > 0) return { undone: false, reason: directoryInTheWay(blocked, "undo") };
			const restored = this.restoreAll(open.id, pending);
			if (restored.conflicts.length > 0) {
				return { undone: false, reason: directoryInTheWay(restored.conflicts, "undo") };
			}
			return this.finalizeUndo(open.id, intent.stepNo);
		}

		const top = this.store.journalRead((db) =>
			db
				.prepare("SELECT stepNo FROM refactor_steps WHERE transactionId = ? ORDER BY stepNo DESC LIMIT 1")
				.get(open.id),
		) as { stepNo: number } | undefined;
		if (!top) return { undone: false, reason: nothingToUndo() };

		const images = this.imagesOf(open.id, "step", top.stepNo);
		const blocked = this.directoriesAt(images);
		if (blocked.length > 0) return { undone: false, reason: directoryInTheWay(blocked, "undo") };
		for (const image of images) {
			if (image.afterHash === null) continue;
			const current = this.snapshot(image.module);
			// A file at its before-image needs no restore.
			if (holds(current, image.existedBefore, image.beforeHash)) continue;
			if ("foreign" in current || current.hash !== image.afterHash) {
				return { undone: false, reason: undoWouldDiscard(image.module, top.stepNo) };
			}
		}

		this.markRecovery(open.id, "undo", top.stepNo);
		const restored = this.restoreAll(open.id, images);
		if (restored.conflicts.length > 0) {
			return { undone: false, reason: directoryInTheWay(restored.conflicts, "undo") };
		}
		this.failAfterRestore?.();
		return this.finalizeUndo(open.id, top.stepNo);
	}

	/** Restores tracked baselines. See `docs/daemon-protocol.md` `refactorRevert`. */
	revert(drifted: TransactionStatus["drifted"], expect?: Expectation): RevertedTransaction {
		const open = this.openTransaction();
		if (!this.asShown(open, expect)) return { reverted: false, modules: [], reason: refactorChangedSinceShown() };
		if (!open) return { reverted: false, modules: [], reason: noTransactionOpen() };
		const intent = this.recoveryIntent(open.id);
		if (intent !== null && intent.operation !== "revert") {
			return { reverted: false, modules: [], reason: recoveryPending(intent.operation) };
		}
		const observed = intent === null ? this.observeKnownStates(open.id) : null;
		if (observed !== null && !sameDrift(observed.drifted, drifted)) {
			return { reverted: false, modules: [], reason: refactorDriftChangedSinceShown() };
		}

		const images = this.imagesOf(open.id, "baseline", 0);
		const diskStates =
			observed === null
				? (intent?.diskStates ?? null)
				: images.map((image) => {
						const state = observed.diskStates.find((candidate) => candidate.module === image.module);
						if (state === undefined) throw new Error(`tracked module has no known state: ${image.module}`);
						return state;
					});
		const outside = diskStates?.find((state) => state.kind === "outside");
		if (outside) return { reverted: false, modules: [], reason: refactorPathLeavesWorkspace(outside.module) };
		const blocked = this.directoriesAt(images);
		if (blocked.length > 0) return { reverted: false, modules: [], reason: directoryInTheWay(blocked, "revert") };
		if (intent !== null) {
			const restored = this.restoreAll(open.id, images, intent.diskStates);
			if (restored.conflicts.length > 0) {
				const unsafe = restored.conflicts.find((module) => this.diskState(module).kind === "outside");
				if (unsafe) return { reverted: false, modules: [], reason: refactorPathLeavesWorkspace(unsafe) };
				return { reverted: false, modules: [], reason: directoryInTheWay(restored.conflicts, "revert") };
			}
			return this.finalizeRevert(open.id);
		}

		this.markRecovery(open.id, "revert", null, diskStates);
		const restored = this.restoreAll(open.id, images, diskStates);
		if (restored.conflicts.length > 0) {
			const unsafe = restored.conflicts.find((module) => this.diskState(module).kind === "outside");
			if (unsafe) return { reverted: false, modules: [], reason: refactorPathLeavesWorkspace(unsafe) };
			return { reverted: false, modules: [], reason: directoryInTheWay(restored.conflicts, "revert") };
		}
		this.failAfterRestore?.();
		return this.finalizeRevert(open.id);
	}

	/** Closes the transaction. See `docs/daemon-protocol.md` `refactorCommit`. */
	commit(options: { force?: boolean | undefined; expect?: Expectation | undefined } = {}): CommittedTransaction {
		const open = this.openTransaction();
		if (!this.asShown(open, options.expect)) {
			return { committed: false, issues: [], reason: refactorChangedSinceShown() };
		}
		if (!open) return { committed: false, issues: [], reason: noTransactionOpen() };
		const intent = this.recoveryIntent(open.id);
		if (intent !== null) {
			return { committed: false, issues: this.issues(open.id), reason: recoveryPending(intent.operation) };
		}

		const issues = this.issues(open.id);
		if (issues.length > 0 && options.force !== true) {
			return { committed: false, issues, reason: unresolvedIssues(issues.length) };
		}

		this.close(open.id, "committed");
		return { committed: true, issues };
	}

	////////////////////////////////
	//  Recovery

	/** Resumes journaled recovery. See `docs/architecture.md` Refactor transactions. */
	recover(): Recovered {
		this.sweepTemporaries();

		const open = this.openTransaction();
		if (!open) return { recovered: false, restored: [], conflicts: [], unreversed: [] };
		const outcome = this.putBack(open);
		if (open.origin !== "own" || this.openTransaction()?.id !== open.id || this.recoveryIntent(open.id) !== null)
			return outcome;

		const closed = this.stepCount(open.id) > 0 ? "committed" : "reverted";
		this.close(open.id, closed);
		return { ...outcome, closed };
	}

	private putBack(open: { id: string }): Recovered {
		// Recovery preserves directories at restore paths.
		const intent = this.recoveryIntent(open.id);
		if (intent?.operation === "undo" && intent.stepNo !== null) {
			const { restored, conflicts } = this.restoreAll(open.id, this.imagesOf(open.id, "step", intent.stepNo));
			if (conflicts.length > 0) {
				return { recovered: true, transactionId: open.id, restored, conflicts, unreversed: [] };
			}
			const outcome = this.finalizeUndo(open.id, intent.stepNo);
			return {
				recovered: true,
				transactionId: open.id,
				restored,
				conflicts,
				unreversed: outcome.unreversed ?? [],
			};
		}
		if (intent?.operation === "revert") {
			const { restored, conflicts } = this.restoreAll(
				open.id,
				this.imagesOf(open.id, "baseline", 0),
				intent.diskStates,
			);
			if (conflicts.length > 0) {
				return { recovered: true, transactionId: open.id, restored, conflicts, unreversed: [] };
			}
			const outcome = this.finalizeRevert(open.id);
			return {
				recovered: true,
				transactionId: open.id,
				restored,
				conflicts,
				unreversed: outcome.unreversed ?? [],
			};
		}

		const unfinished = this.store.journalRead((db) =>
			db
				.prepare(
					"SELECT stepNo, phase FROM refactor_steps WHERE transactionId = ? AND phase != 'finalized' ORDER BY stepNo DESC",
				)
				.all(open.id),
		) as Array<{ stepNo: number; phase: StepPhase }>;

		const restored: string[] = [];
		const conflicts: string[] = [];
		const unreversed: KeptRebind[] = [];

		for (const step of unfinished) {
			const conflictsBefore = conflicts.length;
			for (const image of this.imagesOf(open.id, "step", step.stepNo)) {
				const current = this.snapshot(image.module);

				if (holds(current, image.existedBefore, image.beforeHash)) {
					this.rememberRestored(open.id, image);
					continue;
				}
				if (image.afterHash !== null && holds(current, true, image.afterHash)) {
					this.restore(image);
					this.rememberRestored(open.id, image);
					restored.push(image.module);
					continue;
				}
				// A state matching neither image is a conflict and stays on disk.
				conflicts.push(image.module);
			}

			// Keep a move whose source and target both conflicted.
			// Other subject moves reverse in the same journal write as image cleanup.
			const conflicted = new Set(conflicts.slice(conflictsBefore));
			const touched = (symbolId: string) => conflicted.has(moduleOf(symbolId) ?? "");
			const applied = this.rebindsOf(open.id, step.stepNo).filter(
				({ from, to }) => !(touched(from) && touched(to)),
			);
			const kept = this.store.journalWrite((db) => {
				const { kept } = this.store.subjects.rebindBack(applied);
				db.prepare("DELETE FROM refactor_images WHERE transactionId = ? AND scope = 'step' AND stepNo = ?").run(
					open.id,
					step.stepNo,
				);
				db.prepare("DELETE FROM refactor_rebinds WHERE transactionId = ? AND stepNo = ?").run(
					open.id,
					step.stepNo,
				);
				db.prepare("DELETE FROM refactor_steps WHERE transactionId = ? AND stepNo = ?").run(
					open.id,
					step.stepNo,
				);
				return kept;
			});
			unreversed.push(...kept);
		}

		return { recovered: true, transactionId: open.id, restored, conflicts, unreversed };
	}

	////////////////////////////////
	//  Files

	private recoveryIntent(transactionId: string): RecoveryIntent | null {
		const row = this.store.journalRead((db) =>
			db
				.prepare("SELECT operation, stepNo, diskStates FROM refactor_recovery_intents WHERE transactionId = ?")
				.get(transactionId),
		) as { operation: "undo" | "revert"; stepNo: number | null; diskStates: string | null } | undefined;
		return row === undefined ? null : { ...row, diskStates: parseDiskStates(row.diskStates) };
	}

	private markRecovery(
		transactionId: string,
		operation: RecoveryIntent["operation"],
		stepNo: number | null,
		diskStates: DiskState[] | null = null,
	): void {
		this.store.journalWrite((db) =>
			db
				.prepare(
					"INSERT INTO refactor_recovery_intents (transactionId, operation, stepNo, diskStates) VALUES (?, ?, ?, ?)",
				)
				.run(transactionId, operation, stepNo, diskStates === null ? null : JSON.stringify(diskStates)),
		);
	}

	private finalizeUndo(transactionId: string, stepNo: number): UndoneStep {
		const images = this.imagesOf(transactionId, "step", stepNo);
		const applied = this.rebindsOf(transactionId, stepNo);
		const kept = this.store.journalWrite((db) => {
			const { kept } = this.store.subjects.rebindBack(applied);
			db.prepare("DELETE FROM refactor_images WHERE transactionId = ? AND scope = 'step' AND stepNo = ?").run(
				transactionId,
				stepNo,
			);
			db.prepare("DELETE FROM refactor_issues WHERE transactionId = ? AND stepNo = ?").run(transactionId, stepNo);
			db.prepare("DELETE FROM refactor_rebinds WHERE transactionId = ? AND stepNo = ?").run(
				transactionId,
				stepNo,
			);
			db.prepare("DELETE FROM refactor_steps WHERE transactionId = ? AND stepNo = ?").run(transactionId, stepNo);
			db.prepare("DELETE FROM refactor_recovery_intents WHERE transactionId = ?").run(transactionId);
			return kept;
		});
		return {
			undone: true,
			stepNo,
			modules: images.map((image) => image.module),
			...(kept.length === 0 ? {} : { unreversed: kept }),
		};
	}

	private finalizeRevert(transactionId: string): RevertedTransaction {
		const images = this.imagesOf(transactionId, "baseline", 0);
		const steps = this.store.journalRead((db) =>
			db
				.prepare("SELECT stepNo FROM refactor_steps WHERE transactionId = ? ORDER BY stepNo DESC")
				.all(transactionId),
		) as Array<{ stepNo: number }>;
		const moves = steps.map((step) => this.rebindsOf(transactionId, step.stepNo));
		const kept = this.store.journalWrite((db) => {
			const kept: KeptRebind[] = [];
			for (const applied of moves) kept.push(...this.store.subjects.rebindBack(applied).kept);
			this.drop(db, transactionId, "reverted");
			db.prepare("DELETE FROM refactor_recovery_intents WHERE transactionId = ?").run(transactionId);
			return kept;
		});
		this.store.pruneBlobs();
		return {
			reverted: true,
			modules: images.map((image) => image.module),
			...(kept.length === 0 ? {} : { unreversed: kept }),
		};
	}

	private full(module: string): string {
		return insideWorkspace(this.workspaceRoot, module);
	}

	/** The leaf itself, never its link target; null if outside. */
	private contained(module: string): string | null {
		const where = resolveContained(this.workspaceRoot, module, "keep");
		return where.kind === "outside" ? null : where.path;
	}

	/** Reads regular files without following links. */
	private snapshot(module: string): PathState {
		const leaf = readLeaf(this.full(module));
		if (leaf.kind === "missing") return { module, existed: false, hash: null };
		if (leaf.kind !== "file") return { module, foreign: leaf.kind };

		const hash = hashBytes(leaf.bytes);
		this.store.putBlob(hash, leaf.bytes);
		return { module, existed: true, hash };
	}

	private diskState(module: string): DiskState {
		return this.observe(module).state;
	}

	/** Hashes and retains bytes from one read. */
	private observe(module: string): { state: DiskState; bytes: Buffer | null } {
		const full = this.contained(module);
		if (full === null) return { state: { module, kind: "outside" }, bytes: null };
		const leaf = readLeaf(full);
		if (leaf.kind === "missing") return { state: { module, kind: "missing" }, bytes: null };
		if (leaf.kind === "file")
			return { state: { module, kind: "file", hash: hashBytes(leaf.bytes) }, bytes: leaf.bytes };
		if (leaf.kind === "link") {
			try {
				return { state: { module, kind: "link", target: readlinkSync(full) }, bytes: null };
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT")
					return { state: { module, kind: "missing" }, bytes: null };
				throw error;
			}
		}
		if (leaf.kind === "directory") return { state: { module, kind: "directory" }, bytes: null };
		const found = lstatOf(full);
		const state: DiskState =
			found === null
				? { module, kind: "missing" }
				: { module, kind: "special", identity: `${found.dev}:${found.ino}:${found.mode}` };
		return { state, bytes: null };
	}

	private observeKnownStates(
		transactionId: string,
		known = this.knownStates(transactionId),
	): { diskStates: DiskState[]; drifted: Array<{ module: string; contentHash: string | null }> } {
		const diskStates = known.map((state) => this.diskState(state.module));
		const drifted = known.flatMap((state, index) => {
			const current = diskStates[index];
			if (current === undefined || diskStateHoldsImage(current, state.existed, state.hash)) return [];
			return [{ module: state.module, contentHash: current.kind === "file" ? current.hash : null }];
		});
		return {
			diskStates,
			drifted: drifted.sort((left, right) =>
				left.module < right.module ? -1 : left.module > right.module ? 1 : 0,
			),
		};
	}

	private knownState(transactionId: string, module: string): KnownFileState | null {
		const row = this.store.journalRead((db) =>
			db
				.prepare(
					"SELECT module, existed, contentHash, edited FROM refactor_known_states WHERE transactionId = ? AND module = ?",
				)
				.get(transactionId, module),
		) as { module: string; existed: number; contentHash: string | null; edited: number } | undefined;
		return row === undefined
			? null
			: { module: row.module, existed: row.existed === 1, hash: row.contentHash, edited: row.edited === 1 };
	}

	private knownStates(transactionId: string): KnownFileState[] {
		const rows = this.store.journalRead((db) =>
			db
				.prepare(
					"SELECT module, existed, contentHash, edited FROM refactor_known_states WHERE transactionId = ? ORDER BY module",
				)
				.all(transactionId),
		) as Array<{ module: string; existed: number; contentHash: string | null; edited: number }>;
		return rows.map((row) => ({
			module: row.module,
			existed: row.existed === 1,
			hash: row.contentHash,
			edited: row.edited === 1,
		}));
	}

	private writeKnownState(
		db: DatabaseSync,
		transactionId: string,
		module: string,
		existed: boolean,
		hash: string | null,
		edited: boolean,
	): void {
		db.prepare(
			`INSERT INTO refactor_known_states (transactionId, module, existed, contentHash, edited)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(transactionId, module) DO UPDATE SET
				existed = excluded.existed, contentHash = excluded.contentHash, edited = excluded.edited`,
		).run(transactionId, module, existed ? 1 : 0, hash, edited ? 1 : 0);
	}

	private rememberRestored(
		transactionId: string,
		image: { module: string; existedBefore: boolean; beforeHash: string | null; beforeEdited: boolean },
	): void {
		this.store.journalWrite((db) =>
			this.writeKnownState(
				db,
				transactionId,
				image.module,
				image.existedBefore,
				image.beforeHash,
				image.beforeEdited,
			),
		);
	}

	private directoriesAt(images: Array<{ module: string }>): string[] {
		return images
			.filter((image) => {
				const full = this.contained(image.module);
				return full !== null && lstatOf(full)?.isDirectory() === true;
			})
			.map((image) => image.module);
	}

	/** Replaces or removes a leaf without following links; directories block restore. */
	private restore(image: { module: string; existedBefore: boolean; beforeHash: string | null }): boolean {
		const full = this.contained(image.module);
		if (full === null) return false;
		if (lstatOf(full)?.isDirectory() === true) return false;

		if (!image.existedBefore) {
			rmSync(full, { force: true });
			return true;
		}

		// Skip identical bytes to preserve the timestamp and avoid a watcher event.
		const leaf = readLeaf(full);
		if (leaf.kind === "file" && hashBytes(leaf.bytes) === image.beforeHash) return true;

		const bytes = image.beforeHash === null ? null : this.store.blob(image.beforeHash);
		if (bytes === null) return true;

		writeSourceFile(full, bytes);
		return true;
	}

	private restoreAll(
		transactionId: string,
		images: Array<{
			module: string;
			existedBefore: boolean;
			beforeHash: string | null;
			beforeEdited: boolean;
		}>,
		expectedStates?: DiskState[] | null,
	): {
		restored: string[];
		conflicts: string[];
	} {
		const restored: string[] = [];
		const conflicts: string[] = [];
		for (const image of images) {
			if (expectedStates !== undefined) {
				const current = this.diskState(image.module);
				const expected = expectedStates?.find((state) => state.module === image.module);
				if (
					(expected === undefined || !sameDiskState(current, expected)) &&
					!diskStateHoldsImage(current, image.existedBefore, image.beforeHash)
				) {
					conflicts.push(image.module);
					continue;
				}
			}
			if (this.restore(image)) {
				restored.push(image.module);
				this.rememberRestored(transactionId, image);
			} else conflicts.push(image.module);
		}
		return { restored, conflicts };
	}

	private asShown(open: { id: string; revision: number } | null, expect: Expectation | undefined): boolean {
		if (expect === undefined) return true;
		return open !== null && open.id === expect.id && open.revision === expect.revision;
	}

	/** Removes staging files for modules still held by the journal. */
	private sweepTemporaries(): void {
		const rows = this.store.journalRead((db) =>
			db.prepare("SELECT DISTINCT module FROM refactor_images").all(),
		) as Array<{ module: string }>;

		for (const row of rows) sweepTemporary(this.full(row.module));
	}

	////////////////////////////////
	//  Journal rows

	private stepCount(transactionId: string): number {
		const row = this.store.journalRead((db) =>
			db.prepare("SELECT COUNT(*) AS steps FROM refactor_steps WHERE transactionId = ?").get(transactionId),
		) as { steps: number };
		return row.steps;
	}

	private nextStepNo(transactionId: string): number {
		const row = this.store.journalRead((db) =>
			db.prepare("SELECT MAX(stepNo) AS top FROM refactor_steps WHERE transactionId = ?").get(transactionId),
		) as { top: number | null };
		return (row.top ?? 0) + 1;
	}

	private modulesOf(transactionId: string, stepNo: number): string[] {
		return this.imagesOf(transactionId, "step", stepNo).map((image) => image.module);
	}

	private imagesOf(
		transactionId: string,
		scope: ImageScope,
		stepNo: number,
	): Array<{
		module: string;
		existedBefore: boolean;
		beforeHash: string | null;
		afterHash: string | null;
		beforeEdited: boolean;
	}> {
		const rows = this.store.journalRead((db) =>
			db
				.prepare(
					`SELECT module, existedBefore, beforeHash, afterHash, beforeEdited FROM refactor_images
					 WHERE transactionId = ? AND scope = ? AND stepNo = ?`,
				)
				.all(transactionId, scope, stepNo),
		) as Array<{
			module: string;
			existedBefore: number;
			beforeHash: string | null;
			afterHash: string | null;
			beforeEdited: number;
		}>;

		return rows.map((row) => ({
			...row,
			existedBefore: row.existedBefore === 1,
			beforeEdited: row.beforeEdited === 1,
		}));
	}

	/** Reads subject moves in journal order with the prior state needed to reverse them. */
	private rebindsOf(transactionId: string, stepNo: number): AppliedRebind[] {
		const rows = this.store.journalRead((db) =>
			db
				.prepare(
					`SELECT subjectId, fromSymbolId, toSymbolId, priorFrom, priorEvidence, priorBoundAt, priorState, priorOrphanedAt
					 FROM refactor_rebinds WHERE transactionId = ? AND stepNo = ? ORDER BY ordinal`,
				)
				.all(transactionId, stepNo),
		) as Array<{
			subjectId: string;
			fromSymbolId: string;
			toSymbolId: string;
			priorFrom: string | null;
			priorEvidence: AppliedRebind["priorEvidence"];
			priorBoundAt: number;
			priorState: AppliedRebind["priorState"];
			priorOrphanedAt: number | null;
		}>;
		return rows.map((row) => ({
			subjectId: row.subjectId,
			from: row.fromSymbolId,
			to: row.toSymbolId,
			priorFrom: row.priorFrom,
			priorEvidence: row.priorEvidence,
			priorBoundAt: row.priorBoundAt,
			priorState: row.priorState,
			priorOrphanedAt: row.priorOrphanedAt,
		}));
	}

	private imageFor(transactionId: string, scope: ImageScope, stepNo: number, module: string): boolean {
		const row = this.store.journalRead((db) =>
			db
				.prepare(
					"SELECT 1 AS found FROM refactor_images WHERE transactionId = ? AND scope = ? AND stepNo = ? AND module = ?",
				)
				.get(transactionId, scope, stepNo, module),
		) as { found: number } | undefined;
		return row !== undefined;
	}

	private writeImage(
		transactionId: string,
		scope: ImageScope,
		stepNo: number,
		image: FileImage,
		plannedAfter?: FileImage,
		beforeEdited = false,
	): void {
		this.store.journalWrite((db) => {
			db.prepare(
				`INSERT OR REPLACE INTO refactor_images
				 (transactionId, scope, stepNo, module, existedBefore, beforeHash, existsAfter, afterHash, beforeEdited)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				transactionId,
				scope,
				stepNo,
				image.module,
				image.existed ? 1 : 0,
				image.hash,
				plannedAfter === undefined ? null : plannedAfter.existed ? 1 : 0,
				plannedAfter?.hash ?? null,
				beforeEdited ? 1 : 0,
			);
		});
	}

	private claimBaseline(transactionId: string, image: FileImage): void {
		this.store.journalWrite((db) => {
			db.prepare(
				`INSERT OR IGNORE INTO refactor_images
				 (transactionId, scope, stepNo, module, existedBefore, beforeHash, existsAfter, afterHash, beforeEdited)
				 VALUES (?, 'baseline', 0, ?, ?, ?, NULL, NULL, 0)`,
			).run(transactionId, image.module, image.existed ? 1 : 0, image.hash);
			this.writeKnownState(db, transactionId, image.module, image.existed, image.hash, false);
		});
	}

	/** Writes settlement snapshots before pruning blobs. */
	private close(transactionId: string, outcome: "committed" | "reverted"): void {
		this.store.journalWrite((db) => this.drop(db, transactionId, outcome));
		this.store.pruneBlobs();
	}

	/** Settles the transaction and removes rows atomically. */
	private drop(db: DatabaseSync, transactionId: string, outcome: "committed" | "reverted"): void {
		const origin =
			(
				db.prepare("SELECT origin FROM refactor_transactions WHERE id = ?").get(transactionId) as
					| { origin: TransactionOrigin | null }
					| undefined
			)?.origin ?? "explicit";
		const baselines = db
			.prepare(
				"SELECT module, existedBefore, beforeHash FROM refactor_images WHERE transactionId = ? AND scope = 'baseline' ORDER BY module",
			)
			.all(transactionId) as Array<{ module: string; existedBefore: number; beforeHash: string | null }>;
		const known = new Map(
			(
				db
					.prepare("SELECT module, existed, contentHash FROM refactor_known_states WHERE transactionId = ?")
					.all(transactionId) as Array<{ module: string; existed: number; contentHash: string | null }>
			).map((row) => [row.module, row.existed === 1 ? row.contentHash : null]),
		);

		const { lastInsertRowid } = db
			.prepare("INSERT INTO refactor_settlements (transactionId, origin, outcome, closedAt) VALUES (?, ?, ?, ?)")
			.run(transactionId, origin, outcome, this.now());
		const settle = db.prepare(
			"INSERT INTO refactor_settled_files (seq, module, opened, settled, drifted, driftedHash) VALUES (?, ?, ?, ?, ?, ?)",
		);
		for (const baseline of baselines) {
			const opened = baseline.existedBefore === 1 ? baseline.beforeHash : null;
			const state = known.get(baseline.module);
			// Revert uses baseline state.
			const settled = outcome === "reverted" || state === undefined ? opened : state;
			const disk = this.diskState(baseline.module);
			const drifted = !diskStateHoldsImage(disk, settled !== null, settled);
			const driftedHash = drifted && disk.kind === "file" ? disk.hash : null;
			settle.run(Number(lastInsertRowid), baseline.module, opened, settled, drifted ? 1 : 0, driftedHash);
		}

		db.prepare("DELETE FROM refactor_images WHERE transactionId = ?").run(transactionId);
		db.prepare("DELETE FROM refactor_known_states WHERE transactionId = ?").run(transactionId);
		db.prepare("DELETE FROM refactor_issues WHERE transactionId = ?").run(transactionId);
		db.prepare("DELETE FROM refactor_rebinds WHERE transactionId = ?").run(transactionId);
		db.prepare("DELETE FROM refactor_steps WHERE transactionId = ?").run(transactionId);
		db.prepare("UPDATE refactor_transactions SET state = ? WHERE id = ?").run(outcome, transactionId);

		db.prepare(
			"DELETE FROM refactor_settlements WHERE seq NOT IN (SELECT seq FROM refactor_settlements ORDER BY seq DESC LIMIT ?)",
		).run(SETTLEMENTS_KEPT);
		db.prepare("DELETE FROM refactor_settled_files WHERE seq NOT IN (SELECT seq FROM refactor_settlements)").run();
		db.prepare(
			"DELETE FROM refactor_transactions WHERE state != 'open' AND id NOT IN (SELECT transactionId FROM refactor_settlements)",
		).run();
	}
}
