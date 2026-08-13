// The refactor journal: the one module that reads or writes the refactor_ tables.
//
// A residue test holds that ownership, because the journal is the only record of what a
// half-applied refactor used to look like. A second writer that got a phase transition slightly
// wrong would not corrupt a query, it would lose the ability to put files back.
//
// Files are snapshotted as raw bytes. A source file that is not valid UTF-8 still has to come back
// byte-identical, and hashing decoded text would let two different files share an image.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { IndexStore } from "./store.js";

////////////////////////////////
//  Interfaces & Types

/**
 * How far a step got. Each is committed BEFORE the work it names, so a crash is always readable as
 * "this may have happened" rather than leaving a gap between two phases that both look complete.
 */
export type StepPhase = "journaled" | "written" | "reindexed" | "finalized";

export type StepKind = "replace" | "rename" | "move" | "track";

/** Where a snapshot belongs. The baseline is what revert restores; a step image is what undo does. */
export type ImageScope = "baseline" | "step";

export interface RefactorIssue {
	kind: string;
	detail: string;
	module?: string;
	line?: number;
	/** Which step introduced it, so status can point at one rather than at the workspace. */
	stepNo?: number;
}

export interface TransactionStep {
	stepNo: number;
	kind: StepKind;
	phase: StepPhase;
	modules: string[];
}

export interface TransactionStatus {
	open: boolean;
	id?: string;
	startedAt?: number;
	steps: TransactionStep[];
	tracked: string[];
	issues: RefactorIssue[];
}

/** What a file looked like, and whether it was there at all. Absent and empty are different. */
export interface FileImage {
	module: string;
	existed: boolean;
	hash: string | null;
}

export type StepOutcome = { ok: true; stepNo: number } | { ok: false; reason: string };

////////////////////////////////
//  Functions & Helpers

/** Over bytes, not decoded text, so two files that differ only in encoding never share an image. */
export function hashBytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex").slice(0, 32);
}

////////////////////////////////
//  Class

/**
 * One per workspace, owned by the daemon.
 *
 * Every method here assumes the workspace gate is already held by its caller. Acquiring it inside
 * would deadlock against the caller that took it to make its decision, and taking it later than
 * the decision would let another writer invalidate the hashes this one just checked.
 */
export class TransactionManager {
	constructor(
		private readonly store: IndexStore,
		private readonly workspaceRoot: string,
		private readonly now: () => number = Date.now,
	) {}

	////////////////////////////////
	//  Lifecycle

	/** Refuses a second transaction rather than nesting: one workspace, one stack of undo. */
	start(): { started: boolean; id: string; reason?: string } {
		const open = this.openTransaction();
		if (open) return { started: false, id: open.id, reason: "a refactor transaction is already open" };

		const id = `rt-${this.now().toString(36)}-${Math.trunc(Math.random() * 0xfffff).toString(36)}`;
		this.store.journal((db) => {
			db.prepare("INSERT INTO refactor_transactions (id, state, startedAt) VALUES (?, ?, ?)").run(
				id,
				"open",
				this.now(),
			);
		});
		return { started: true, id };
	}

	openTransaction(): { id: string; startedAt: number } | null {
		const row = this.store.journal((db) =>
			db.prepare("SELECT id, startedAt FROM refactor_transactions WHERE state = 'open'").get(),
		) as { id: string; startedAt: number } | undefined;
		return row ?? null;
	}

	/**
	 * Snapshots a file's current bytes as the transaction's opening image.
	 *
	 * Never overwrites an existing baseline. Tracking a file a step already touched would move the
	 * mark revert restores to, so revert would stop at a mid-transaction state and call it the
	 * beginning.
	 */
	track(module: string): { tracked: boolean; reason?: string } {
		const open = this.openTransaction();
		if (!open) return { tracked: false, reason: "no refactor transaction is open" };

		if (this.imageFor(open.id, "baseline", 0, module)) return { tracked: true };
		this.writeImage(open.id, "baseline", 0, this.snapshot(module));
		return { tracked: true };
	}

	status(): TransactionStatus {
		const open = this.openTransaction();
		if (!open) return { open: false, steps: [], tracked: [], issues: [] };

		const steps = this.store.journal((db) =>
			db
				.prepare("SELECT stepNo, kind, phase FROM refactor_steps WHERE transactionId = ? ORDER BY stepNo")
				.all(open.id),
		) as Array<{ stepNo: number; kind: StepKind; phase: StepPhase }>;

		const images = this.store.journal((db) =>
			db.prepare("SELECT scope, stepNo, module FROM refactor_images WHERE transactionId = ?").all(open.id),
		) as Array<{ scope: ImageScope; stepNo: number | null; module: string }>;

		return {
			open: true,
			id: open.id,
			startedAt: open.startedAt,
			steps: steps.map((step) => ({
				...step,
				modules: images
					.filter((image) => image.scope === "step" && image.stepNo === step.stepNo)
					.map((i) => i.module),
			})),
			tracked: [
				...new Set(images.filter((image) => image.scope === "baseline").map((image) => image.module)),
			].sort(),
			issues: this.issues(open.id),
		};
	}

	issues(transactionId: string): RefactorIssue[] {
		const rows = this.store.journal((db) =>
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

	/**
	 * Records a step and its before-images, then hands back the number to write under.
	 *
	 * Journaling happens before any file is touched, so the phase a crash leaves behind always
	 * over-states progress rather than under-stating it. Recovery can undo work that never
	 * happened; it cannot undo work it has no record of.
	 */
	beginStep(kind: StepKind, modules: string[], plan?: unknown): StepOutcome {
		const open = this.openTransaction();
		if (!open) return { ok: false, reason: "no refactor transaction is open" };

		const stepNo = this.nextStepNo(open.id);
		const images = modules.map((module) => this.snapshot(module));

		this.store.journal((db) => {
			db.prepare(
				"INSERT INTO refactor_steps (transactionId, stepNo, kind, phase, plan, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
			).run(open.id, stepNo, kind, "journaled", plan === undefined ? null : JSON.stringify(plan), this.now());
		});

		for (const image of images) {
			// The baseline is claimed here too, so a file a step touches is revertible even when
			// nobody thought to track it first.
			if (!this.imageFor(open.id, "baseline", 0, image.module)) {
				this.writeImage(open.id, "baseline", 0, image);
			}
			this.writeImage(open.id, "step", stepNo, image);
		}

		return { ok: true, stepNo };
	}

	/** Records what the step produced, so undo can tell its own output from a later manual edit. */
	completeStep(stepNo: number, phase: StepPhase): void {
		const open = this.openTransaction();
		if (!open) return;

		if (phase === "written") {
			const modules = this.modulesOf(open.id, stepNo);
			for (const module of modules) {
				const after = this.snapshot(module);
				this.store.journal((db) => {
					db.prepare(
						`UPDATE refactor_images SET existsAfter = ?, afterHash = ?
						 WHERE transactionId = ? AND scope = 'step' AND stepNo = ? AND module = ?`,
					).run(after.existed ? 1 : 0, after.hash, open.id, stepNo, module);
				});
			}
		}

		this.store.journal((db) => {
			db.prepare("UPDATE refactor_steps SET phase = ? WHERE transactionId = ? AND stepNo = ?").run(
				phase,
				open.id,
				stepNo,
			);
		});
	}

	recordIssues(stepNo: number, issues: RefactorIssue[]): void {
		const open = this.openTransaction();
		if (!open || issues.length === 0) return;

		this.store.journal((db) => {
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

	/**
	 * Restores the newest step, refusing when a file no longer holds what that step wrote.
	 *
	 * The hash check is what keeps undo from eating a manual edit. A file that changed after the
	 * step is not the step's output any more, and putting the old bytes back would silently discard
	 * whatever replaced them.
	 */
	undo(): { undone: boolean; stepNo?: number; modules?: string[]; reason?: string } {
		const open = this.openTransaction();
		if (!open) return { undone: false, reason: "no refactor transaction is open" };

		const top = this.store.journal((db) =>
			db
				.prepare("SELECT stepNo FROM refactor_steps WHERE transactionId = ? ORDER BY stepNo DESC LIMIT 1")
				.get(open.id),
		) as { stepNo: number } | undefined;
		if (!top) return { undone: false, reason: "this transaction has no steps to undo" };

		const images = this.imagesOf(open.id, "step", top.stepNo);
		for (const image of images) {
			if (image.afterHash === null) continue;
			const current = this.snapshot(image.module);
			if (current.hash !== image.afterHash) {
				return {
					undone: false,
					reason: `${image.module} changed after step ${top.stepNo}, so undoing it would discard that edit`,
				};
			}
		}

		for (const image of images) this.restore(image);

		this.store.journal((db) => {
			db.prepare("DELETE FROM refactor_images WHERE transactionId = ? AND scope = 'step' AND stepNo = ?").run(
				open.id,
				top.stepNo,
			);
			db.prepare("DELETE FROM refactor_issues WHERE transactionId = ? AND stepNo = ?").run(open.id, top.stepNo);
			db.prepare("DELETE FROM refactor_steps WHERE transactionId = ? AND stepNo = ?").run(open.id, top.stepNo);
		});

		return { undone: true, stepNo: top.stepNo, modules: images.map((image) => image.module) };
	}

	/** Puts every tracked file back to its opening image, whatever happened in between. */
	revert(): { reverted: boolean; modules: string[]; reason?: string } {
		const open = this.openTransaction();
		if (!open) return { reverted: false, modules: [], reason: "no refactor transaction is open" };

		const images = this.imagesOf(open.id, "baseline", 0);
		for (const image of images) this.restore(image);
		this.close(open.id, "reverted");

		return { reverted: true, modules: images.map((image) => image.module) };
	}

	/** Keeps what is on disk and drops the journal, so nothing can be undone afterwards. */
	commit(options: { force?: boolean | undefined } = {}): {
		committed: boolean;
		issues: RefactorIssue[];
		reason?: string;
	} {
		const open = this.openTransaction();
		if (!open) return { committed: false, issues: [], reason: "no refactor transaction is open" };

		const issues = this.issues(open.id);
		if (issues.length > 0 && options.force !== true) {
			return {
				committed: false,
				issues,
				reason: `${issues.length} unresolved issue${issues.length === 1 ? "" : "s"}; undo and correct, or commit with force`,
			};
		}

		this.close(open.id, "committed");
		return { committed: true, issues };
	}

	////////////////////////////////
	//  Recovery

	/**
	 * Puts the workspace back to a phase boundary after a crash, before anyone can ask about it.
	 *
	 * A step is judged by what its files actually hold rather than by its phase alone, because the
	 * phase says what was STARTED. A file matching neither image is someone else's edit and is
	 * never overwritten: reporting a conflict is recoverable, and silently reverting a stranger's
	 * work is not.
	 */
	recover(): { recovered: boolean; transactionId?: string; restored: string[]; conflicts: string[] } {
		this.sweepTemporaries();

		const open = this.openTransaction();
		if (!open) return { recovered: false, restored: [], conflicts: [] };

		const unfinished = this.store.journal((db) =>
			db
				.prepare(
					"SELECT stepNo, phase FROM refactor_steps WHERE transactionId = ? AND phase != 'finalized' ORDER BY stepNo DESC",
				)
				.all(open.id),
		) as Array<{ stepNo: number; phase: StepPhase }>;

		const restored: string[] = [];
		const conflicts: string[] = [];

		for (const step of unfinished) {
			for (const image of this.imagesOf(open.id, "step", step.stepNo)) {
				const current = this.snapshot(image.module);

				if (current.hash === image.beforeHash && current.existed === image.existedBefore) continue;
				if (image.afterHash !== null && current.hash === image.afterHash) {
					this.restore(image);
					restored.push(image.module);
					continue;
				}
				// Matches neither: written past what the journal knows, or edited by someone else.
				conflicts.push(image.module);
			}

			this.store.journal((db) => {
				db.prepare("DELETE FROM refactor_images WHERE transactionId = ? AND scope = 'step' AND stepNo = ?").run(
					open.id,
					step.stepNo,
				);
				db.prepare("DELETE FROM refactor_steps WHERE transactionId = ? AND stepNo = ?").run(
					open.id,
					step.stepNo,
				);
			});
		}

		return { recovered: true, transactionId: open.id, restored, conflicts };
	}

	////////////////////////////////
	//  Files

	private full(module: string): string {
		return path.join(this.workspaceRoot, module);
	}

	/** Reads bytes and stores them, returning what is needed to put the file back exactly. */
	private snapshot(module: string): FileImage {
		const full = this.full(module);
		if (!existsSync(full)) return { module, existed: false, hash: null };

		const bytes = readFileSync(full);
		const hash = hashBytes(bytes);
		this.store.putBlob(hash, bytes);
		return { module, existed: true, hash };
	}

	/** Temp file plus rename, so a crash mid-restore cannot truncate the file being restored. */
	private restore(image: { module: string; existedBefore: boolean; beforeHash: string | null }): void {
		const full = this.full(image.module);

		if (!image.existedBefore) {
			rmSync(full, { force: true });
			return;
		}

		const bytes = image.beforeHash === null ? null : this.store.blob(image.beforeHash);
		if (bytes === null) return;

		mkdirSync(path.dirname(full), { recursive: true });
		const temporary = `${full}.lexicon-tmp`;
		writeFileSync(temporary, bytes);
		renameSync(temporary, full);
	}

	/** Left behind when a write died between its temp file and its rename. */
	private sweepTemporaries(): void {
		const rows = this.store.journal((db) =>
			db.prepare("SELECT DISTINCT module FROM refactor_images").all(),
		) as Array<{ module: string }>;

		for (const row of rows) {
			const temporary = `${this.full(row.module)}.lexicon-tmp`;
			if (existsSync(temporary)) rmSync(temporary, { force: true });
		}
	}

	////////////////////////////////
	//  Journal rows

	private nextStepNo(transactionId: string): number {
		const row = this.store.journal((db) =>
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
	): Array<{ module: string; existedBefore: boolean; beforeHash: string | null; afterHash: string | null }> {
		const rows = this.store.journal((db) =>
			db
				.prepare(
					`SELECT module, existedBefore, beforeHash, afterHash FROM refactor_images
					 WHERE transactionId = ? AND scope = ? AND stepNo = ?`,
				)
				.all(transactionId, scope, stepNo),
		) as Array<{ module: string; existedBefore: number; beforeHash: string | null; afterHash: string | null }>;

		return rows.map((row) => ({ ...row, existedBefore: row.existedBefore === 1 }));
	}

	private imageFor(transactionId: string, scope: ImageScope, stepNo: number, module: string): boolean {
		const row = this.store.journal((db) =>
			db
				.prepare(
					"SELECT 1 AS found FROM refactor_images WHERE transactionId = ? AND scope = ? AND stepNo = ? AND module = ?",
				)
				.get(transactionId, scope, stepNo, module),
		) as { found: number } | undefined;
		return row !== undefined;
	}

	private writeImage(transactionId: string, scope: ImageScope, stepNo: number, image: FileImage): void {
		this.store.journal((db) => {
			db.prepare(
				`INSERT OR REPLACE INTO refactor_images
				 (transactionId, scope, stepNo, module, existedBefore, beforeHash) VALUES (?, ?, ?, ?, ?, ?)`,
			).run(transactionId, scope, stepNo, image.module, image.existed ? 1 : 0, image.hash);
		});
	}

	/** Drops everything but the transaction row, which keeps its outcome for anyone still asking. */
	private close(transactionId: string, state: "committed" | "reverted"): void {
		this.store.journal((db) => {
			db.prepare("DELETE FROM refactor_images WHERE transactionId = ?").run(transactionId);
			db.prepare("DELETE FROM refactor_issues WHERE transactionId = ?").run(transactionId);
			db.prepare("DELETE FROM refactor_steps WHERE transactionId = ?").run(transactionId);
			db.prepare("UPDATE refactor_transactions SET state = ? WHERE id = ?").run(state, transactionId);
		});
		this.store.pruneBlobs();
	}
}
