// The index. Facts only: traversal, ranking and cycle collapsing happen in application code.
//
// Reverse lookup is the reason this is a database. References are recorded at the use site, so
// "who uses this" has no cheap answer in memory, and an index on the target column turns it into
// the same read as "what is this".

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { storePaths } from "@nyaa-lexicon/client";
import {
	type AllList,
	type ContentTotals,
	commentFactId,
	type Declaration,
	type DocRegion,
	declarationFactId,
	defined,
	docFactId,
	type EntryHow,
	type Export,
	exportFactId,
	type FileContent,
	type FileNote,
	type FileNotes,
	type FileRole,
	hashContent,
	type Import,
	type ImportResolution,
	type IndexDepth,
	importFactId,
	type Landing,
	type Literal,
	literalFactId,
	type ModuleExclusion,
	type OriginEdge,
	ownerStarts,
	type Range,
	type Reference,
	type ReferenceRole,
	type ResolutionMode,
	referenceFactId,
	SCHEMA_VERSION,
	type ScanCounts,
	type ScopeContribution,
	type SecretsConfig,
	SecretsConfigSchema,
	type StoredComment,
	type StoredDeclaration,
	type StoredDoc,
	type StoredExport,
	type StoredFact,
	type StoredImport,
	type StoredLiteral,
	type StoredReference,
	type ValueStatus,
} from "@nyaa-lexicon/protocol";
import { type Clock, systemClock, type TimerHandle } from "./clock.js";
import type { AttachedComment } from "./commentAttach.js";
import { Database } from "./database.js";
import { type EffectiveExport, type ScopeLanding, scopeKey, settleProjections } from "./exportProjection.js";
import { admitFacts, spanKey } from "./factAdmission.js";
import type { GeneratedVerdict } from "./fileScope.js";
import {
	installAdmissionTriggers,
	installRevisionTriggers,
	JOURNAL_DDL,
	JOURNAL_TABLE_NAMES,
	JOURNAL_TABLES,
	type JournalTable,
	keptBlobs,
	keptHashPairs,
} from "./journalSchema.js";
import { stampSeen } from "./lastSeen.js";
import { NoteRows } from "./noteRows.js";
import type { PatternDigest } from "./patternDigest.js";
import { ProjectIndexMarker } from "./projectIndexState.js";
import { normalizeDocText } from "./proseText.js";
import { RELATION_TABLES, RelationRows } from "./relationRows.js";
import type { ScopeFilter } from "./scope.js";
import type {
	AdmittedBytes,
	JournalAdmission,
	SecretAdmission,
	StoredAdmission,
	StoredFailure,
} from "./secretPolicy.js";
import { StoreFactQueries } from "./storeFactQueries.js";
import {
	columnExists,
	liftAppliedRebinds,
	restoreKnowledge,
	salvageKnowledge,
	tableExists,
} from "./storeMigrations.js";
import { StoreProjectionQueries } from "./storeProjections.js";
import {
	clearStaging,
	type HeldAdmission,
	installStaged,
	markNew,
	owesTruncate,
	type PurgeState,
	type ScrubOptions,
	type ScrubReport,
	StorePurge,
	stagingOf,
} from "./storePurge.js";
import type { NoteRow, RoleRow } from "./storeRows.js";
import { roleFromRow, rowToNote } from "./storeRows.js";
import { FACT_TABLES, NOTES_TABLE, SCHEMA } from "./storeSchema.js";
import { StoreSearchQueries } from "./storeSearchQueries.js";
import {
	joinNoteFields,
	KNOWLEDGE_SCHEMA,
	KnowledgeSubjects,
	SWEEP_START,
	type SweepCursor,
	type SweepPass,
	type SweepReport,
} from "./subjects.js";

export type {
	ContentCounts,
	ContentTotals,
	FileNote,
	FileNotes,
	ScanCounts,
	StoredComment,
	StoredDeclaration,
	StoredDoc,
	StoredFact,
	StoredImport,
	StoredLiteral,
	StoredReference,
} from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Interfaces & Types

export interface StoredSecretPolicy {
	secrets: SecretsConfig;
	deny: string[];
}

export interface HeldJournalImage extends StoredAdmission {
	bytes: Uint8Array | null;
}

export interface UnadmittedJournalReference {
	module: string;
	hash: string;
}

function jsonArrayAt(value: unknown, path: string): unknown[] | null {
	let current = value;
	const keys = path === "$" ? [] : path.replace(/^\$\./, "").split(".");
	for (const key of keys) {
		if (typeof current !== "object" || current === null || Array.isArray(current)) return null;
		current = (current as Record<string, unknown>)[key];
	}
	return Array.isArray(current) ? current : null;
}

declare const hiddenBrand: unique symbol;

/** Modules a search skips; only the store mints one. */
export type HiddenModules = readonly string[] & { readonly [hiddenBrand]: true };

export const HiddenModules = {
	/** No exclusion asked. */
	none: Object.freeze([]) as unknown as HiddenModules,
};

export interface LiteralFilter {
	value?: string | undefined;
	kind?: string | undefined;
	low?: number | undefined;
	high?: number | undefined;
	key?: string | undefined;
	/** A file, or every module in a folder. */
	module?: string | undefined;
	scope?: ScopeFilter | undefined;
	hidden: HiddenModules;
}

export interface CommentFilter {
	form?: string | undefined;
	module?: string | undefined;
	hidden: HiddenModules;
}

export interface DocFilter {
	/** Restricts to fenced regions when true, to prose when false, to neither when absent. */
	fenced?: boolean | undefined;
	module?: string | undefined;
	hidden: HiddenModules;
}

type EntryPoint = { module: string } & ({ how: "main"; symbolId: string } | { how: Exclude<EntryHow, "main"> });

/** File facts stored together. */
export interface FileWrite {
	module: string;
	runtime?: "esm" | "cjs";
	contentHash: string;
	declarations: Array<Declaration & { valueStatus?: ValueStatus | undefined }>;
	references: Reference[];
	imports?: Import[];
	literals?: Literal[];
	depth?: IndexDepth;
	comments?: AttachedComment[];
	docs?: DocRegion[];
	notes?: FileNote[];
	content?: FileContent;
	/** Provider id for this parse. */
	provider?: string;
	digests?: PatternDigest[];
	generated?: GeneratedVerdict | null;
	role?: FileRole | undefined;
	/** Where each specifier landed, as the provider resolved it, keyed by `resolutionKey`. */
	resolutions?: ReadonlyMap<string, ImportResolution | null>;
	/** Absent when the provider does not report exports, which is unknown coverage. */
	exports?: Export[] | undefined;
	allList?: AllList | undefined;
	scopeContributions?: ScopeContribution[] | undefined;
}

/** File facts with policy admission. */
export interface ReplaceFileInput extends FileWrite {
	admission: SecretAdmission;
}

declare const overlayBrand: unique symbol;

/** Speculative facts need no admission; only `readOverlaid` creates them. */
export type OverlaidFile = FileWrite & { readonly [overlayBrand]: true };

/** One commit of a module's rows: the depth they hold and the clock stamp the commit took. */
export interface FactsStamp {
	depth: IndexDepth;
	indexedAt: number;
}

/** A write that moved what other modules can bind to, and who may now bind differently. */
export interface SurfaceChange {
	/** Names of declarations the module did not hold in this form before. */
	gained: string[];
	/** Names of declarations the module held before in a form it no longer does. */
	lost: string[];
	/** Other modules with a reference bound to a declaration the module held before. */
	boundInto: string[];
	/** Whether the module held a surface before, so a provider may still hold a parse of what it was. */
	heldBefore: boolean;
	/** Scope keys the module contributed to before or after the write; their importers rebind too. */
	scopes: string[];
}

/** Rebuild carries non-regenerable knowledge and identity. */
export interface Carried {
	salvaged: ReturnType<typeof salvageKnowledge>;
	/** The refactor ledger id. */
	ledger: string | null;
	/** When seeding ended; distinguishes untouched notes. */
	seededAt: number | null;
	/** Whether legacy JSON moves need lifting. */
	liftRebinds: boolean;
}

/** Store creation options. */
export interface CreateOptions {
	clock: Clock;
	/** Major recorded in the store. */
	compatibility?: string | null | undefined;
	scrub?: ScrubOptions | undefined;
}

/** Counts unplaced and unreadable rows. */
type Restored = ReturnType<typeof restoreKnowledge>;

/** One declaration as another module may bind to it. */
interface SurfaceRow {
	symbolId: string;
	name: string;
	kind: string;
	/** A flavour can change what a binding to it loads, e.g. an enum inlined at compile time. */
	languageKind: string | null;
	visibility: string;
	exported: boolean | null;
}

/** One thing another module can bind to, keyed by everything a binding to it depends on. */
interface SurfaceEntry {
	key: string;
	/** The name a use spells; null for a re-export that names none. */
	name: string | null;
}

////////////////////////////////
//  Constants

export { SCHEMA_VERSION };

/** Index writes one batch commits at most; a crash loses no more, and the next scan parses them again. */
export const BATCH_WRITES = 256;

/** The longest a batch stays open: a timer commits it then, idle or not, as does a write past it. */
export const BATCH_MS = 1_000;

/** Stored generations stay below this; a new epoch lifts every generation past all read before it. */
const EPOCH_SPAN = 2 ** 32;

/** The one knowledge write an index write makes: a subject's resolution, which the next parse redoes. */
const RESOLUTION_UPDATE = /^\s*UPDATE\s+knowledge_subjects\b/i;

/** A pass's batch was lost, so index writes the pass reported done were rolled back. */
export class BatchFailed extends Error {
	constructor(cause: unknown) {
		super(`an index batch was lost: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
		this.name = "BatchFailed";
	}
}

/** The first retry of work a lost batch took; each loss in a row doubles it, up to five minutes. */
export const LOST_RETRY_MS = 5_000;

export const lostRetryMs = (losses: number): number => Math.min(LOST_RETRY_MS * 2 ** losses, 5 * 60 * 1000);

/**
 * SQLite's primary codes for the store failing rather than one write's statement: busy, locked, no
 * memory, read-only, interrupted, I/O, corrupt, full, can't open, protocol, not a database.
 */
const STORE_FAILURES = new Set([5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 26]);

const storeFailed = (error: unknown): boolean => {
	const code = (error as { errcode?: unknown } | null)?.errcode;
	return typeof code === "number" && STORE_FAILURES.has(code & 0xff);
};

/** One running pass, and the batch loss it ran into once one did. */
interface PassState {
	lost: BatchFailed | null;
}

/** Meta key for store compatibility. */
const COMPATIBILITY_KEY = "storeCompatibility";

/** Meta key: when notes began. */
const NOTES_SINCE_KEY = "notesSince";
const SECRET_POLICY_KEY = "secretPolicy";

/** How module rows and failures were admitted. */
const HELD_FACTS = "SELECT policyStamp AS stamp, admittedAs FROM files WHERE module = ?";
const HELD_FAILURE = "SELECT policyStamp AS stamp, admittedAs FROM parse_failures WHERE module = ?";

/** Makes a held rebind debt payable again. */
const UNBLOCK = "UPDATE rebind_owed SET blockedBy = NULL, blockedFor = NULL, blockedIn = NULL";

/** Where the last scan's coverage arithmetic lives in the meta table. */
const SCAN_SUMMARY_KEY = "scanSummary";
const PROJECT_INDEX_LIFECYCLE_KEY = "projectIndexLifecycle";

/** Where the last capped sweep stopped, beside the scan summary. */
const SWEEP_CURSOR_KEY = "knowledgeSweepCursor";

/** Prefix of each provider's project fingerprint, suffixed with its id. */
const PROJECT_FINGERPRINT_KEY = "projectFingerprint";

/**
 * Where the indexed workspace's path lives in the meta table.
 *
 * Written so a store can say what it indexed with no daemon running: the path is otherwise only
 * in the lock file, which a stopped daemon takes with it, leaving a hashed directory name and no
 * way to tell a long-gone project from a live one.
 */
const WORKSPACE_KEY = "workspaceRoot";

/** Carries the ledger id across rebuilds. */
const LEDGER_KEY = "refactorLedger";

/** When describe answers seeded notes. */
const NOTES_SEEDED_KEY = "notesSeeded";

/** Null when the table is absent, which is the case on an index written before it existed. */
function readMeta(db: Database, key: string): string | null {
	try {
		const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
		return row?.value ?? null;
	} catch {
		return null;
	}
}

function writeMeta(db: Database, key: string, value: string): void {
	db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
}

/** Why opening drops rows, or null when they remain. */
function rebuildReason(version: number, stored: string | null, compatibility?: string | null): string | null {
	if (version === SCHEMA_VERSION) {
		const moved = compatibility != null && stored !== null && stored !== compatibility;
		return moved ? "a major version has shipped since this index was written" : null;
	}
	return version === 0 ? null : "the index schema changed";
}

/** Whether opening retains this file's rows. */
function keepsRows(file: string, compatibility?: string | null): boolean {
	let db: Database;
	try {
		db = Database.open(file, { readOnly: true });
	} catch {
		return false;
	}
	try {
		const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
		return (
			version === SCHEMA_VERSION &&
			rebuildReason(version, readMeta(db, COMPATIBILITY_KEY), compatibility) === null
		);
	} catch {
		return false;
	} finally {
		db.close();
	}
}

/** Store identity captured before replacement. */
function originOf(db: Database): Omit<Carried, "salvaged"> {
	const seeded = readMeta(db, NOTES_SEEDED_KEY);
	return {
		ledger: readMeta(db, LEDGER_KEY),
		seededAt: seeded === null || !Number.isFinite(Number(seeded)) ? null : Number(seeded),
		// Lift JSON move records from tableless stores.
		liftRebinds: !tableExists(db, "refactor_rebinds"),
	};
}

/** Knowledge and identity carried from a store. */
export function carriedFrom(db: Database, origin: Omit<Carried, "salvaged"> = originOf(db)): Carried {
	return { ...origin, salvaged: salvageKnowledge(db) };
}

/** Whether the file contains store tables. */
function holdsStore(db: Database): boolean {
	return (
		db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get() !== undefined
	);
}

/**
 * Restores knowledge atomically and records the schema version last.
 */
function fillStore(db: Database, carried: Carried, options: CreateOptions): Restored {
	db.exec("BEGIN IMMEDIATE");
	try {
		db.exec(SCHEMA);
		const restored = restoreKnowledge(db, carried.salvaged, options.clock.now(), carried.seededAt);
		// Lift JSON journal rows in this commit.
		if (carried.liftRebinds) restored.dropped += liftAppliedRebinds(db);
		writeMeta(db, LEDGER_KEY, carried.ledger ?? randomUUID());
		writeMeta(db, PROJECT_INDEX_LIFECYCLE_KEY, "unknown");
		if (options.compatibility != null) writeMeta(db, COMPATIBILITY_KEY, options.compatibility);
		markNew(db, options.scrub);
		db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
		db.exec("COMMIT");
		return restored;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

/**
 * Stages restored rows, then closes and replaces the old store after WAL truncation.
 * Uncarried rows are omitted.
 */
export function createStoreFile(
	file: string,
	carried: Carried,
	options: CreateOptions,
	held: Database | null = null,
): Restored {
	clearStaging(file);
	const staged = Database.open(stagingOf(file));
	let restored: Restored;
	try {
		restored = fillStore(staged, carried, options);
		// The staged file is complete before WAL mode.
		staged.exec("PRAGMA journal_mode = WAL");
	} finally {
		staged.close();
	}
	new ProjectIndexMarker(storePaths(path.dirname(file)).indexedStateFile).clear();
	installStaged(file, held, options.scrub);
	return restored;
}

/** Null admissions represent plain rows. */
function admittedAsOf(admission: SecretAdmission | null): string | null {
	return admission === null || admission.as === "plain" ? null : admission.as;
}

/** The persisted cursor, or the start when none is held or the held one has no recognisable shape. */
function readSweepCursor(db: Database): SweepCursor {
	const raw = readMeta(db, SWEEP_CURSOR_KEY);
	if (raw === null) return SWEEP_START;
	try {
		const parsed = JSON.parse(raw) as Partial<SweepCursor>;
		if (typeof parsed.epoch !== "number") return SWEEP_START;
		if (parsed.pass === "B" && (parsed.after === null || typeof parsed.after === "string")) {
			return { epoch: parsed.epoch, pass: "B", after: parsed.after };
		}
		if (parsed.pass === "A") {
			const after = parsed.after;
			if (after === null) return { epoch: parsed.epoch, pass: "A", after: null };
			if (
				typeof after === "object" &&
				typeof after.orphanedAt === "number" &&
				typeof after.subjectId === "string"
			) {
				return {
					epoch: parsed.epoch,
					pass: "A",
					after: { orphanedAt: after.orphanedAt, subjectId: after.subjectId },
				};
			}
		}
		return SWEEP_START;
	} catch {
		return SWEEP_START;
	}
}

/** A sweep report survives the summary only whole; a partial one reads as no sweep. */
function sweepReportOf(value: unknown): SweepReport | null {
	if (typeof value !== "object" || value === null) return null;
	const report = value as Record<string, unknown> & {
		examined?: unknown;
		rebound?: unknown;
		orphaned?: unknown;
		deleted?: unknown;
		ambiguous?: unknown;
		stoppedEarly?: unknown;
	};
	const counts = ["examined", "rebound", "orphaned", "deleted", "ambiguous"] as const;
	if (counts.some((key) => typeof report[key] !== "number") || typeof report.stoppedEarly !== "boolean") return null;
	return {
		examined: report.examined as number,
		rebound: report.rebound as number,
		orphaned: report.orphaned as number,
		deleted: report.deleted as number,
		ambiguous: report.ambiguous as number,
		stoppedEarly: report.stoppedEarly as boolean,
	};
}

/** A declaration another module may bind to, keyed by its id, kind, flavour and exposure. */
function declarationEntry(row: SurfaceRow): SurfaceEntry {
	return {
		key: JSON.stringify([row.symbolId, row.kind, row.languageKind, row.visibility, row.exported]),
		name: row.name,
	};
}

/**
 * What a write lets another module bind to by declaration: one entry per id, as the symbols table
 * keeps them, locals aside. What it exports moves with its projection, at settlement.
 */
function surfaceOf(declarations: readonly Declaration[]): SurfaceEntry[] {
	const byId = new Map<string, SurfaceEntry>();
	for (const d of declarations) {
		if (d.visibility === "local") continue;
		const { symbolId, name, kind, visibility } = d;
		const languageKind = d.languageKind ?? null;
		byId.set(
			symbolId,
			declarationEntry({ symbolId, name, kind, languageKind, visibility, exported: d.exported ?? null }),
		);
	}
	return [...byId.values()].sort((left, right) => (left.key < right.key ? -1 : 1));
}

function namesOf(entries: readonly SurfaceEntry[]): string[] {
	return [...new Set(entries.flatMap((entry) => (entry.name === null ? [] : [entry.name])))].sort();
}

/** A `resolutions` key: one per specifier and resolution mode. */
export function resolutionKey(specifier: string, mode: ResolutionMode | undefined): string {
	return mode === undefined ? specifier : `${specifier}\u0000${mode}`;
}

/** A resolved specifier's landing; null when it is external or unresolved. */
function landingOf(resolution: ImportResolution | null): Landing | null {
	return resolution?.status === "resolved" ? resolution.landing : null;
}

/** JSON with sorted keys and no undefined values, so two equal objects spell alike. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value)
			.filter(([, each]) => each !== undefined)
			.sort(([left], [right]) => (left < right ? -1 : 1));
		return `{${entries.map(([key, each]) => `${JSON.stringify(key)}:${canonical(each)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

/**
 * Each import edge by its span, with its occurrence among identical edges, for reference ids.
 * Position and source order stay out of the identity, so an import moving re-mints nothing.
 */
function originEdges(imports: readonly Import[]): Map<string, OriginEdge> {
	const seen = new Map<string, number>();
	const out = new Map<string, OriginEdge>();
	for (const statement of imports) {
		for (const edge of statement.edges) {
			const { span: _span, range: _range, localRange: _localRange, order: _order, ...content } = edge;
			const key = canonical([statement.specifier, content]);
			const occurrence = seen.get(key) ?? 0;
			seen.set(key, occurrence + 1);
			out.set(spanKey(edge.span), { specifier: statement.specifier, edge, occurrence });
		}
	}
	return out;
}

////////////////////////////////
//  Class

export class IndexStore {
	/** The one owner of knowledge identity. */
	readonly subjects: KnowledgeSubjects;
	/** Note rows, keyed by subject. */
	readonly notes: NoteRows;
	/** Stated relations, feedback counts and discovery state. */
	readonly relations: RelationRows;
	private readonly factQueries: StoreFactQueries;
	private readonly searchQueries: StoreSearchQueries;
	private readonly projectionQueries: StoreProjectionQueries;

	/** The newest stamp written or held, so no two commits share one. */
	private newestStamp: number;
	/** In-process knowledge-changing writes. */
	private knowledgeTurns = 0;
	private transactionDepth = 0;
	private speculating = false;
	private pendingKnowledgeWrite = false;
	/** Each running pass; while any does, the index writes it makes share open transactions. */
	private readonly running = new Set<PassState>();
	/** The pass a write runs under, carried across its awaits, so a loss refuses only the passes it hit. */
	private readonly passOf = new AsyncLocalStorage<PassState>();
	/**
	 * The open transaction batched writes share, until it commits: the generation advances before it,
	 * and who waits to hear whether it landed.
	 */
	private batch: {
		since: number;
		writes: number;
		advances: number;
		timer: TimerHandle;
		landed: Array<(committed: boolean) => void>;
	} | null = null;
	/** Stored generation advances so far, so a rollback moves the epoch only when it took one back. */
	private advances = 0;
	/** Index writes open, inside which knowledge rows take only a subject's resolution. */
	private indexWrites = 0;
	/** Whether the WAL needs truncation. */
	private readonly purge: StorePurge;
	/** Generations read outside a speculation carry it; a rollback moves it past every epoch used. */
	private epoch = 0;
	private nextEpoch = 1;
	/** Each speculation's own, so what it reads never matches a generation read outside it. */
	private speculationEpoch = 0;

	private constructor(
		private readonly db: Database,
		private readonly clock: Clock,
		private readonly indexedState: ProjectIndexMarker,
		private readonly workspaceRoot?: string,
	) {
		this.purge = new StorePurge(db, clock, () => this.batch !== null || this.transactionDepth > 0);
		const knowledge = db.checkedWrites((sql) => this.checkKnowledgeWrite(sql));
		this.subjects = new KnowledgeSubjects(knowledge, (changed) => this.recordKnowledgeWrite(changed));
		this.notes = new NoteRows(knowledge, (changed) => this.recordKnowledgeWrite(changed));
		this.relations = new RelationRows(knowledge, (changed) => this.recordKnowledgeWrite(changed));
		// Fact queries must exist before newestIndexedAt delegates to them.
		this.factQueries = new StoreFactQueries(db);
		this.searchQueries = new StoreSearchQueries(db, HiddenModules.none);
		this.projectionQueries = new StoreProjectionQueries(db);
		this.newestStamp = this.newestIndexedAt() ?? 0;
	}

	projectIndexed(): boolean | undefined {
		if (this.workspaceRoot === undefined) return undefined;
		const lifecycle = readMeta(this.db, PROJECT_INDEX_LIFECYCLE_KEY);
		if (lifecycle === "fresh") return false;
		if (lifecycle !== "complete") return undefined;
		return this.indexedState.belongsToRoot();
	}

	markProjectIndexed(): void {
		if (this.workspaceRoot === undefined) return;
		writeMeta(this.db, PROJECT_INDEX_LIFECYCLE_KEY, "complete");
		this.indexedState.publish(this.clock.now());
	}

	beginProjectIndexing(): void {
		if (this.workspaceRoot === undefined) return;
		if (readMeta(this.db, PROJECT_INDEX_LIFECYCLE_KEY) !== "complete")
			writeMeta(this.db, PROJECT_INDEX_LIFECYCLE_KEY, "unknown");
	}

	/** Runs a note write in one transaction, so a note and its links never land apart. */
	noteWrite<T>(work: () => T): T {
		return this.inTransaction(work);
	}

	/** Runs a relation write in one transaction, so a relation and the subjects it claims land together. */
	relationWrite<T>(work: () => T): T {
		return this.inTransaction(work);
	}

	/** The later of the clock and one past the newest: two commits in one millisecond stay ordered. */
	private nextStamp(): number {
		this.newestStamp = Math.max(this.clock.now(), this.newestStamp + 1);
		return this.newestStamp;
	}

	/**
	 * Runs an index pass whose writes commit together, every `BATCH_WRITES` writes or `BATCH_MS`,
	 * rather than one transaction each. Its end commits whatever is batched, so a pass that returns is
	 * durable. A pass running when a batch is lost writes nothing more and throws `BatchFailed` at its
	 * end; one starting later begins a new batch.
	 */
	async pass<T>(work: () => Promise<T>): Promise<T> {
		const state: PassState = { lost: null };
		this.running.add(state);
		try {
			return await this.passOf.run(state, work);
		} finally {
			this.endPass(state);
		}
	}

	/** Commits what is batched, then throws the loss this pass ran into, if it ran into one. */
	private endPass(state: PassState): void {
		try {
			this.commitBatch();
		} catch {
			// A failed commit is a loss this pass, still running, ran into.
		} finally {
			this.running.delete(state);
		}
		if (state.lost !== null) throw state.lost;
	}

	/** The batch loss the pass this runs under ran into, or null. */
	lostBatch(): BatchFailed | null {
		return this.passOf.getStore()?.lost ?? null;
	}

	/** Runs `work` as no pass's, as background work does that a pass started but does not own. */
	detached<T>(work: () => T): T {
		return this.passOf.exit(work);
	}

	/** An index write: during a pass it joins the pass's batch. */
	private indexWrite<T>(work: () => T): T {
		this.indexWrites++;
		try {
			return this.inTransaction(work, true);
		} finally {
			this.indexWrites--;
		}
	}

	/** Writes that arm purge pay debt after commit. */
	private owingWrite<T>(work: (armed: () => void) => T): T {
		let owes = false;
		try {
			return this.indexWrite(() =>
				work(() => {
					owes = true;
				}),
			);
		} finally {
			if (owes) this.purge.settle(false);
		}
	}

	/** Transactionally arms purge when a plain row's admission or stamp changes. */
	private armIfOwed(next: SecretAdmission, sources: readonly string[], armed: () => void): void {
		for (const sql of sources) {
			const held = this.db.prepare(sql).get(next.module) as HeldAdmission | undefined;
			if (held === undefined || !owesTruncate(held, next)) continue;
			this.purge.arm();
			armed();
			return;
		}
	}

	/** A write about `module` must carry that module's admission. */
	private static assertAdmissionFor(module: string, admission: SecretAdmission): void {
		if (admission.module !== module)
			throw new Error(`the admission for ${admission.module} was given for ${module}`);
	}

	/** Purge debt and start time. */
	purgeState(): PurgeState {
		return this.purge.state();
	}

	/**
	 * Makes every batched write so far durable, and visible to other connections. Never inside an
	 * open write, whose savepoint the commit would end. A failed commit loses the batch.
	 */
	private commitBatch(): void {
		const batch = this.batch;
		if (batch === null || this.transactionDepth > 0) return;
		try {
			this.db.exec("COMMIT");
		} catch (error) {
			this.loseBatch(error);
			throw error;
		}
		this.batch = null;
		this.clock.clearTimer(batch.timer);
		this.purge.settle(false);
		for (const landed of batch.landed) landed(true);
	}

	/**
	 * Rolls the open batch back, and refuses the running passes' index writes until they end, so no
	 * later batch lands ahead of the lost one; the next scan parses those files again. With no batch
	 * open, as when one could not begin, it refuses them all the same.
	 */
	private loseBatch(error: unknown): void {
		const lost = new BatchFailed(error);
		for (const state of this.running) state.lost ??= lost;
		const batch = this.batch;
		this.batch = null;
		this.quietly("ROLLBACK");
		if (batch === null) return;
		this.clock.clearTimer(batch.timer);
		if (this.advances !== batch.advances) this.epoch = this.nextEpoch++;
		for (const landed of batch.landed) landed(false);
	}

	/**
	 * Calls `landed` with true once the write just made is committed, at once when no batch holds it,
	 * or with false when its batch is lost instead.
	 */
	whenCommitted(landed: (committed: boolean) => void): void {
		if (this.batch === null) landed(true);
		else this.batch.landed.push(landed);
	}

	/** Runs a rollback, false where SQLite already ended what it would end. */
	private quietly(sql: string): boolean {
		try {
			this.db.exec(sql);
			return true;
		} catch {
			return false;
		}
	}

	/** Closes one write's depth, counting a knowledge change only once its outermost write landed. */
	private endWrite(landed: boolean): void {
		this.transactionDepth--;
		if (this.transactionDepth > 0) return;
		if (landed && this.pendingKnowledgeWrite) this.knowledgeTurns++;
		this.pendingKnowledgeWrite = false;
	}

	/**
	 * The batch timer's commit, so a stalled pass never keeps the write lock. Firing inside a write it
	 * commits nothing, and that write's own bound check commits once it ends.
	 */
	private commitDueBatch(): void {
		try {
			this.commitBatch();
		} catch {
			// No caller to take it; the pass throws it when it ends.
		}
	}

	/**
	 * node:sqlite has no transaction helper, so one wrapper owns the begin/commit/rollback. Under a
	 * speculation it is a savepoint, which the speculation's rollback discards with everything else.
	 * An index write during a pass joins the pass's open batch as a savepoint; any other write first
	 * commits that batch, so it is durable on return and lands after everything batched before it.
	 */
	private inTransaction<T>(work: () => T, batched = false): T {
		const pass = this.passOf.getStore();
		if (batched && !this.speculating && pass !== undefined) return this.inBatch(pass, work);
		if (!this.speculating) this.commitBatch();
		const savepoint = this.speculating ? `nested${this.transactionDepth}` : null;
		const advances = this.advances;
		this.db.exec(savepoint === null ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
		this.transactionDepth++;
		let result: T;
		try {
			result = work();
			this.db.exec(savepoint === null ? "COMMIT" : `RELEASE ${savepoint}`);
		} catch (error) {
			this.endWrite(false);
			// Fails where SQLite already ended the transaction; the error that ended it is the one thrown.
			this.quietly(savepoint === null ? "ROLLBACK" : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
			if (savepoint === null && this.advances !== advances) this.epoch = this.nextEpoch++;
			throw error;
		}
		this.endWrite(true);
		return result;
	}

	/**
	 * One write inside the open batch. An error in what the write asked, such as a constraint refusing
	 * a provider's answer, rolls back that write alone, so one file never costs a pass; the store
	 * failing, as a full disk or another process's lock does, loses the batch, whether or not SQLite
	 * ended the transaction, and whether or not the batch had begun.
	 */
	private inBatch<T>(pass: PassState, work: () => T): T {
		// A write outliving its pass would land in a batch no running pass owns.
		if (!this.running.has(pass)) throw new Error("an index write ran under a pass that had already ended");
		if (pass.lost !== null) throw pass.lost;
		if (this.batch === null) {
			try {
				this.db.exec("BEGIN IMMEDIATE");
			} catch (error) {
				if (storeFailed(error)) this.loseBatch(error);
				throw error;
			}
			this.batch = {
				since: this.clock.now(),
				writes: 0,
				advances: this.advances,
				timer: this.clock.setTimer(() => this.commitDueBatch(), BATCH_MS),
				landed: [],
			};
		}
		const batch = this.batch;
		const advances = this.advances;
		this.db.exec("SAVEPOINT batched");
		this.transactionDepth++;
		let result: T;
		try {
			result = work();
			this.db.exec("RELEASE batched");
		} catch (error) {
			this.endWrite(false);
			if (storeFailed(error) || !this.quietly("ROLLBACK TO batched; RELEASE batched")) this.loseBatch(error);
			else if (this.advances !== advances) this.epoch = this.nextEpoch++;
			throw error;
		}
		this.endWrite(true);
		batch.writes++;
		if (batch.writes >= BATCH_WRITES || this.clock.now() - batch.since >= BATCH_MS) this.commitBatch();
		return result;
	}

	/**
	 * Reads with `facts` standing in for their modules' stored facts, projections settled, then rolls
	 * every write back; `read` gets the modules whose exports moved. Synchronous, so no other read sees them.
	 */
	readOverlaid<T>(facts: readonly FileWrite[], read: (moved: string[]) => T): T {
		return this.speculate(() => {
			for (const each of facts) this.replaceFile(each as OverlaidFile);
			return read(this.settleProjections());
		});
	}

	/**
	 * Runs `work` over writes that never land: every write inside it, settled projections included,
	 * rolls back when it returns or throws. Synchronous, so no other read sees the writes.
	 */
	private speculate<T>(work: () => T): T {
		if (this.transactionDepth > 0) throw new Error("a speculation cannot open inside a transaction");
		this.commitBatch();
		this.db.exec("BEGIN IMMEDIATE");
		this.transactionDepth++;
		this.speculating = true;
		this.speculationEpoch = this.nextEpoch++;
		try {
			const result = work();
			if (result instanceof Promise) throw new Error("a speculation must finish synchronously");
			return result;
		} finally {
			this.quietly("ROLLBACK");
			this.transactionDepth--;
			this.speculating = false;
			this.pendingKnowledgeWrite = false;
		}
	}

	/** Refuses a knowledge write outside a store transaction, and any but a resolution inside an index write. */
	private checkKnowledgeWrite(sql: string): void {
		if (this.transactionDepth === 0) throw new Error(`a knowledge write ran outside a store transaction: ${sql}`);
		if (this.indexWrites > 0 && !RESOLUTION_UPDATE.test(sql))
			throw new Error(`an index write changes no knowledge but a subject's resolution: ${sql}`);
	}

	/** A stored generation in the current epoch, so a number read before a rollback never names other facts. */
	private generation(stored: number): number {
		return (this.speculating ? this.speculationEpoch : this.epoch) * EPOCH_SPAN + stored;
	}

	private recordKnowledgeWrite(changed: boolean): void {
		if (!changed) return;
		if (this.transactionDepth > 0) {
			this.pendingKnowledgeWrite = true;
			return;
		}
		this.knowledgeTurns++;
	}

	/** First open scrubs existing files; rebuilds need no scrub. */
	static async scrubAhead(
		file: string,
		compatibility?: string | null,
		clock: Clock = systemClock,
		options: ScrubOptions = {},
	): Promise<ScrubReport | null> {
		return keepsRows(file, compatibility) ? StorePurge.scrubAhead(file, clock, options) : null;
	}

	/**
	 * Opens or rebuilds the index.
	 * `compatibility` is the writing major.
	 * Rebuilds stage beside the old store and install by rename.
	 * Existing stores rewrite freed pages once per major before writes.
	 * Rebuilt stores need no scrub; `scrub` is absent when none was due.
	 */
	static open(
		file: string,
		compatibility?: string | null,
		workspaceRoot?: string,
		clock: Clock = systemClock,
		scrubOptions: ScrubOptions = {},
	): {
		store: IndexStore;
		rebuilt: boolean;
		reason?: string;
		unplaced?: number;
		dropped?: number;
		scrub?: ScrubReport;
	} {
		const fresh = !existsSync(file);
		const indexedState = new ProjectIndexMarker(storePaths(path.dirname(file)).indexedStateFile, workspaceRoot);
		clearStaging(file);
		let db = Database.open(file);
		db.exec("PRAGMA journal_mode = WAL");

		let rebuilt = false;
		let unplaced = 0;
		let dropped = 0;
		let reason: string | undefined;
		let version = 0;
		try {
			version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
		} catch {
			version = -1;
		}
		const initialized = fresh || version === 0;

		// Read identity before replacing its store.
		const stored = version === SCHEMA_VERSION ? readMeta(db, COMPATIBILITY_KEY) : null;
		const origin = originOf(db);
		const rebuildFor = rebuildReason(version, stored, compatibility);
		if (rebuildFor !== null) {
			reason = rebuildFor;
			if (version === SCHEMA_VERSION) version = -1;
		}

		if (version !== SCHEMA_VERSION) {
			// Knowledge crosses the rebuild: facts reindex from source; notes cannot be regenerated.
			const carried = carriedFrom(db, origin);
			const making: CreateOptions = { clock, compatibility, scrub: scrubOptions };
			// Replace stores; in-place drops do not zero freed pages.
			if (holdsStore(db)) {
				({ unplaced, dropped } = createStoreFile(file, carried, making, db));
				db = Database.open(file);
				db.exec("PRAGMA journal_mode = WAL");
			} else {
				indexedState.clear();
				({ unplaced, dropped } = fillStore(db, carried, making));
			}
			rebuilt = version !== 0;
		} else if (origin.liftRebinds) {
			// Table and lift in one commit, or a crash between them reads as a store that already lifted.
			db.exec("BEGIN IMMEDIATE");
			try {
				db.exec(JOURNAL_TABLES.refactor_rebinds.ddl);
				dropped += liftAppliedRebinds(db);
				db.exec("COMMIT");
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		}

		// Index additions are safe to apply in place, so existing stores get this lookup without a rebuild.
		db.exec("CREATE INDEX IF NOT EXISTS files_indexed_at ON files(indexedAt)");
		db.exec("CREATE INDEX IF NOT EXISTS refs_from ON refs(fromId)");
		// Nullable, so the add is one atomic statement and an old row reads as not yet recorded.
		if (!columnExists(db, "files", "content")) db.exec("ALTER TABLE files ADD COLUMN content TEXT");
		if (!columnExists(db, "files", "policyStamp")) db.exec("ALTER TABLE files ADD COLUMN policyStamp TEXT");
		if (!columnExists(db, "parse_failures", "policyStamp"))
			db.exec("ALTER TABLE parse_failures ADD COLUMN policyStamp TEXT");
		// Null admissions represent plain rows.
		if (!columnExists(db, "files", "admittedAs")) db.exec("ALTER TABLE files ADD COLUMN admittedAs TEXT");
		if (!columnExists(db, "parse_failures", "admittedAs"))
			db.exec("ALTER TABLE parse_failures ADD COLUMN admittedAs TEXT");
		if (!columnExists(db, "symbols", "valueStatus")) {
			db.exec("ALTER TABLE symbols ADD COLUMN valueStatus TEXT CHECK (valueStatus IN ('set', 'empty'))");
		}
		// Each column checked on its own, so a crash between the two adds is finished on the next open.
		if (!columnExists(db, "files", "generated")) db.exec("ALTER TABLE files ADD COLUMN generated TEXT");
		if (!columnExists(db, "files", "generatedReason")) db.exec("ALTER TABLE files ADD COLUMN generatedReason TEXT");
		if (!columnExists(db, "symbols", "synthesizedName")) {
			db.exec("ALTER TABLE symbols ADD COLUMN synthesizedName INTEGER");
		}
		if (!columnExists(db, "symbols", "patternDigest")) db.exec("ALTER TABLE symbols ADD COLUMN patternDigest TEXT");
		if (!columnExists(db, "refactor_transactions", "origin")) {
			db.exec("ALTER TABLE refactor_transactions ADD COLUMN origin TEXT");
		}
		if (!columnExists(db, "refactor_transactions", "revision")) {
			db.exec(
				"ALTER TABLE refactor_transactions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)",
			);
		}
		if (!columnExists(db, "symbols", "patternCoverage")) {
			db.exec("ALTER TABLE symbols ADD COLUMN patternCoverage TEXT");
		}
		if (!columnExists(db, "symbols", "contains")) {
			db.exec("ALTER TABLE symbols ADD COLUMN contains TEXT CHECK (contains IN ('members', 'locals'))");
		}
		// Once, in place, keeping every note someone wrote.
		if (columnExists(db, "symbol_notes", "summary")) {
			db.exec("BEGIN IMMEDIATE");
			try {
				joinNoteFields(db, origin.seededAt);
				db.exec("COMMIT");
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		}
		// Every statement is IF NOT EXISTS, so an index, trigger or view added later lands on an existing store here.
		db.exec(KNOWLEDGE_SCHEMA);
		db.exec(RELATION_TABLES);
		db.exec(JOURNAL_DDL);
		if (!columnExists(db, "refactor_recovery_intents", "diskStates")) {
			db.exec("ALTER TABLE refactor_recovery_intents ADD COLUMN diskStates TEXT");
		}
		if (!columnExists(db, "refactor_images", "beforeEdited")) {
			db.exec(
				"ALTER TABLE refactor_images ADD COLUMN beforeEdited INTEGER NOT NULL DEFAULT 0 CHECK (beforeEdited IN (0, 1))",
			);
		}
		db.exec(`
			INSERT OR IGNORE INTO refactor_known_states (transactionId, module, existed, contentHash, edited)
			SELECT baseline.transactionId, baseline.module,
				CASE WHEN latest.existsAfter = 1 THEN 1
					WHEN latest.existsAfter = 0 THEN 0
					ELSE baseline.existedBefore END,
				CASE WHEN latest.existsAfter = 1 THEN latest.afterHash
					WHEN latest.existsAfter = 0 THEN NULL
					ELSE baseline.beforeHash END,
				0
			FROM refactor_images AS baseline
			LEFT JOIN refactor_images AS latest
				ON latest.transactionId = baseline.transactionId
				AND latest.module = baseline.module
				AND latest.scope = 'step'
				AND latest.stepNo = (
					SELECT MAX(image.stepNo)
					FROM refactor_images AS image
					JOIN refactor_steps AS step
						ON step.transactionId = image.transactionId AND step.stepNo = image.stepNo
					WHERE image.transactionId = baseline.transactionId
						AND image.module = baseline.module
						AND image.scope = 'step'
						AND step.phase IN ('written', 'reindexed', 'finalized')
						AND (image.existsAfter = 0 OR (image.existsAfter = 1 AND image.afterHash IS NOT NULL))
						AND (image.afterHash IS NULL OR EXISTS (
							SELECT 1 FROM refactor_admissions AS admission
							WHERE admission.module = image.module AND admission.hash = image.afterHash
						))
				)
			LEFT JOIN refactor_admissions AS baselineAdmission
				ON baselineAdmission.module = baseline.module AND baselineAdmission.hash = baseline.beforeHash
			WHERE baseline.scope = 'baseline'
				AND (
					(baseline.existedBefore = 0 AND baseline.beforeHash IS NULL)
					OR (baseline.existedBefore = 1 AND baselineAdmission.hash IS NOT NULL)
				)
		`);
		installRevisionTriggers(db);
		installAdmissionTriggers(db);
		if (readMeta(db, LEDGER_KEY) === null) writeMeta(db, LEDGER_KEY, origin.ledger ?? randomUUID());

		// Marker and table together, or a crash between them reads as a fresh table.
		if (!tableExists(db, "notes")) {
			db.exec("BEGIN IMMEDIATE");
			try {
				if (readMeta(db, NOTES_SINCE_KEY) === null) writeMeta(db, NOTES_SINCE_KEY, String(clock.now()));
				db.exec(NOTES_TABLE);
				db.exec("COMMIT");
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		} else if (readMeta(db, NOTES_SINCE_KEY) === null) {
			writeMeta(db, NOTES_SINCE_KEY, "0");
		}

		// Persist the key on every open.
		if (compatibility != null) writeMeta(db, COMPATIBILITY_KEY, compatibility);
		if (workspaceRoot !== undefined) {
			writeMeta(db, WORKSPACE_KEY, workspaceRoot);
			// A daemon opening on its root has seen the root.
			stampSeen(db, clock.now());
		}

		const store = new IndexStore(db, clock, indexedState, workspaceRoot);
		store.purge.settle(false);
		const scrub = store.purge.scrub(file, scrubOptions);
		if (initialized) writeMeta(db, PROJECT_INDEX_LIFECYCLE_KEY, "fresh");
		else if (
			workspaceRoot !== undefined &&
			readMeta(db, PROJECT_INDEX_LIFECYCLE_KEY) === null &&
			!store.indexedState.exists() &&
			store.readScanSummary()?.outlined === true
		)
			store.markProjectIndexed();
		return {
			store,
			rebuilt,
			...defined({ reason }),
			...(unplaced === 0 ? {} : { unplaced }),
			...(dropped === 0 ? {} : { dropped }),
			...(scrub === null ? {} : { scrub }),
		};
	}

	////////////////////////////////
	//  Writing

	/**
	 * Replaces everything one file contributed, in one transaction.
	 *
	 * Surgical by module, which is what makes an edit cost a delete and some inserts rather than a
	 * whole-index rebuild. The delete-then-insert is not an optimization: a symbol removed from a
	 * file has to disappear, and an upsert alone would leave it behind forever.
	 *
	 * Answers what the write moved of the module's declared surface, read before its old rows go, or
	 * null when other modules can bind to exactly what they could before. What it moved of the module's
	 * exports is settled after, from the projection debt the write records.
	 *
	 * Admission or stamp changes can arm plain-row purge; overlays carry no admission.
	 */
	replaceFile(input: ReplaceFileInput | OverlaidFile): SurfaceChange | null {
		const admission = "admission" in input ? input.admission : null;
		if (admission !== null) IndexStore.assertAdmissionFor(input.module, admission);
		const {
			module,
			contentHash,
			declarations,
			references,
			imports = [],
			literals = [],
			depth = "full",
			comments = [],
			docs = [],
			notes = [],
			content = "code",
			provider = null,
			digests = [],
			generated = null,
			role,
			resolutions = new Map(),
			exports,
			allList,
			scopeContributions = [],
		} = input;
		const landings = [...resolutions.values()].flatMap((resolution) => {
			const landing = landingOf(resolution);
			return landing === null ? [] : [landing];
		});
		admitFacts(module, {
			declarations,
			references,
			literals,
			docs,
			role,
			imports,
			exports,
			allList,
			landings,
			provider,
			scopeContributions,
		});
		const owners = ownerStarts(declarations);
		const digestOf = new Map(digests.map((digest) => [digest.symbolId, digest]));
		const through = originEdges(imports);
		const surface = surfaceOf(declarations);
		const surfaceDigest = hashContent(surface.map((entry) => entry.key).join("\n"));
		return this.owingWrite((armed) => {
			if (admission !== null) this.armIfOwed(admission, [HELD_FACTS, HELD_FAILURE], armed);
			const change = this.surfaceChange(module, surface, surfaceDigest);
			const scopesBefore = this.scopeKeysOf(module);
			const before = this.db.prepare("SELECT allList FROM files WHERE module = ?").get(module) as
				| { allList: string | null }
				| undefined;
			const heldBefore = before !== undefined;
			const allListBefore = before?.allList ?? null;
			for (const table of FACT_TABLES) this.db.prepare(`DELETE FROM ${table} WHERE module = ?`).run(module);
			this.db
				.prepare(
					`INSERT OR REPLACE INTO files (module, runtime, contentHash, policyStamp, admittedAs, indexedAt, depth, content, provider, generated, generatedReason,
					 role, roleHow, roleSymbolId, roleReason, surface, exportsKnown, allList)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					module,
					input.runtime ?? null,
					contentHash,
					admission?.stamp ?? null,
					admittedAsOf(admission),
					this.nextStamp(),
					depth,
					content,
					provider,
					generated?.status ?? null,
					generated?.status === "unknown" ? generated.reason : null,
					role?.kind ?? null,
					role?.kind === "entry" ? role.how : null,
					role?.kind === "entry" && role.how === "main" ? role.symbolId : null,
					role?.kind === "unknown" ? role.reason : null,
					surfaceDigest,
					exports === undefined ? 0 : 1,
					allList === undefined ? null : JSON.stringify(allList),
				);
			// A successful parse clears its failure record.
			this.db.prepare("DELETE FROM parse_failures WHERE module = ?").run(module);
			if (change !== null) this.recordMove(module, change);
			// A parse reading references binds against every move so far, so it settles what was owed.
			if (depth !== "outline") this.db.prepare("DELETE FROM rebind_owed WHERE module = ?").run(module);

			const symbol = this.db.prepare(
				`INSERT OR REPLACE INTO symbols
				 (symbolId, factId, module, name, kind, visibility, exported, containerId, signature,
				  startLine, startChar, endLine, endChar, nameLine, nameChar, nameEndLine, nameEndChar,
				  synthesizedName, mLines, mParameters, mNesting, mBranches, patternDigest, patternCoverage, contains,
				  memberInsertLine, languageKind, valueStatus)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			for (const d of declarations) {
				// The name columns are NOT NULL from before names could be absent; the flag says which.
				const named = d.selectionRange ?? { start: d.range.start, end: d.range.start };
				const digest = digestOf.get(d.symbolId);
				symbol.run(
					d.symbolId,
					declarationFactId(module, d),
					module,
					d.name,
					d.kind,
					d.visibility,
					// null, not 0: a provider that cannot answer must not be recorded as saying no.
					d.exported === undefined ? null : d.exported ? 1 : 0,
					d.containerId ?? null,
					d.signature ?? null,
					d.range.start.line,
					d.range.start.character,
					d.range.end.line,
					d.range.end.character,
					named.start.line,
					named.start.character,
					named.end.line,
					named.end.character,
					d.selectionRange === undefined ? 1 : 0,
					d.metrics?.lines ?? null,
					d.metrics?.parameters ?? null,
					d.metrics?.nesting ?? null,
					d.metrics?.branches ?? null,
					digest?.patternDigest ?? null,
					digest?.patternCoverage ?? null,
					d.contains ?? null,
					d.memberInsertLine ?? null,
					d.languageKind ?? null,
					d.valueStatus ?? null,
				);
			}
			this.subjects.restoreResolving(module, this.clock.now());
			this.subjects.refreshDigests(module);

			const reference = this.db.prepare(
				`INSERT INTO refs (factId, module, name, role, targetId, fromId, qualified, provenance, startLine, startChar, endLine, endChar,
				 originKind, originStartLine, originStartChar, originEndLine, originEndChar, originPath)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			for (const r of references) {
				// Unbound rows store reasons; ambiguous rows store provenance.
				const target = r.binding.status === "bound" ? r.binding.symbolId : null;
				const how =
					r.binding.status === "unbound" || r.binding.status === "unknown"
						? r.binding.reason
						: r.binding.provenance;
				const span = r.origin?.kind === "import" ? r.origin.span : undefined;
				const path = r.origin?.kind === "import" ? r.origin.path : undefined;
				reference.run(
					referenceFactId(module, r, owners, span === undefined ? undefined : through.get(spanKey(span))),
					module,
					r.name,
					r.role,
					target,
					r.fromId ?? null,
					r.qualified === undefined ? null : r.qualified ? 1 : 0,
					how,
					r.range.start.line,
					r.range.start.character,
					r.range.end.line,
					r.range.end.character,
					r.origin?.kind ?? null,
					span?.start.line ?? null,
					span?.start.character ?? null,
					span?.end.line ?? null,
					span?.end.character ?? null,
					path === undefined ? null : JSON.stringify(path),
				);
			}

			const importRow = this.db.prepare(
				`INSERT INTO imports (factId, module, specifier, kind, loads, elided, name, startLine, startChar, endLine, endChar,
				 localName, localStartLine, localStartChar, localEndLine, localEndChar,
				 spanStartLine, spanStartChar, spanEndLine, spanEndChar, bindsLocally, typeOnly, edge,
				 landing, target, targetScope, surfaceTarget)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			// One row per edge, a side effect and a wildcard included: the edge is real when it names nothing.
			for (const statement of imports) {
				for (const edge of statement.edges) {
					const resolution = resolutions.get(resolutionKey(statement.specifier, edge.resolutionMode)) ?? null;
					const landing = landingOf(resolution);
					importRow.run(
						importFactId(module, statement.specifier, edge),
						module,
						statement.specifier,
						edge.kind,
						edge.loads ?? null,
						edge.elided === undefined ? null : edge.elided ? 1 : 0,
						edge.name ?? null,
						edge.range?.start.line ?? null,
						edge.range?.start.character ?? null,
						edge.range?.end.line ?? null,
						edge.range?.end.character ?? null,
						edge.local ?? null,
						edge.localRange?.start.line ?? null,
						edge.localRange?.start.character ?? null,
						edge.localRange?.end.line ?? null,
						edge.localRange?.end.character ?? null,
						edge.span.start.line,
						edge.span.start.character,
						edge.span.end.line,
						edge.span.end.character,
						edge.bindsLocally ? 1 : 0,
						edge.typeOnly === true ? 1 : 0,
						JSON.stringify(edge),
						landing === null ? null : JSON.stringify(landing),
						landing?.kind === "module" ? landing.module : null,
						landing === null || landing.kind === "module" ? null : scopeKey(landing),
						resolution?.status === "external" ? (resolution.surface?.module ?? null) : null,
					);
				}
			}

			const exportRow = this.db.prepare(
				"INSERT INTO exports (factId, module, form, name, targetKind, targetSymbolId, edge) VALUES (?, ?, ?, ?, ?, ?, ?)",
			);
			for (const edge of exports ?? []) {
				exportRow.run(
					exportFactId(module, edge),
					module,
					edge.form,
					edge.name ?? null,
					edge.target.kind,
					edge.target.kind === "symbol" ? edge.target.symbolId : null,
					JSON.stringify(edge),
				);
			}

			const contribution = this.db.prepare(
				"INSERT OR IGNORE INTO scope_contributions (module, scopeKey) VALUES (?, ?)",
			);
			const member = this.db.prepare("INSERT INTO scope_members (module, scopeKey, memberId) VALUES (?, ?, ?)");
			for (const scope of scopeContributions) {
				const key = scopeKey({ kind: scope.kind, providerId: provider ?? "", scopeId: scope.scopeId });
				contribution.run(module, key);
				for (const memberId of scope.members) member.run(module, key, memberId);
			}

			const literalRow = this.db.prepare(
				`INSERT INTO literals (factId, module, kind, value, number, containerId, startLine, startChar, endLine, endChar)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			for (const literal of literals) {
				literalRow.run(
					literalFactId(module, literal, owners),
					module,
					literal.kind,
					literal.value,
					literal.number ?? null,
					literal.containerId ?? null,
					literal.range.start.line,
					literal.range.start.character,
					literal.range.end.line,
					literal.range.end.character,
				);
			}

			const commentRow = this.db.prepare(
				`INSERT INTO comments (factId, module, raw, normalized, form, placement, anchorId, startLine, startChar, endLine, endChar)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			for (const comment of comments) {
				// The anchor is recomputed on every pass and written fresh. Nothing migrates an old
				// one forward, so a symbol that moved cannot leave a comment pointing at where it was.
				commentRow.run(
					commentFactId(
						module,
						{ range: comment.range, text: comment.raw, anchorId: comment.anchorId },
						owners,
					),
					module,
					comment.raw,
					comment.normalized,
					comment.form,
					comment.placement,
					comment.anchorId,
					comment.range.start.line,
					comment.range.start.character,
					comment.range.end.line,
					comment.range.end.character,
				);
			}

			const docRow = this.db.prepare(
				`INSERT INTO docs (factId, module, raw, normalized, fenced, anchorId, startLine, startChar, endLine, endChar)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			for (const region of docs) {
				docRow.run(
					docFactId(module, region, owners),
					module,
					region.text,
					normalizeDocText(region.plain ?? region.text),
					region.fenced ? 1 : 0,
					region.anchorId ?? null,
					region.range.start.line,
					region.range.start.character,
					region.range.end.line,
					region.range.end.character,
				);
			}

			const noteRow = this.db.prepare(
				`INSERT INTO notes (module, ordinal, severity, message, path, startLine, startChar, endLine, endChar)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			notes.forEach((note, ordinal) => {
				noteRow.run(
					module,
					ordinal,
					note.severity,
					note.message,
					note.path ?? null,
					note.range?.start.line ?? null,
					note.range?.start.character ?? null,
					note.range?.end.line ?? null,
					note.range?.end.character ?? null,
				);
			});
			// A star selecting by the module's list reads it, so a moved list owes its forwarders.
			if (allListBefore !== (allList === undefined ? null : JSON.stringify(allList))) this.oweForwarders(module);
			this.advanceGenerations(module, scopesBefore, heldBefore, change !== null);
			return change;
		});
	}

	/** What the module's declared surface moved, from the rows it holds before a write replaces them. */
	private surfaceChange(module: string, surface: SurfaceEntry[], digest: string): SurfaceChange | null {
		const file = this.db.prepare("SELECT surface FROM files WHERE module = ?").get(module) as
			| { surface: string | null }
			| undefined;
		if (file?.surface === digest) return null;
		const before = this.surfaceHeld(module);
		const keys = new Set(before.map((entry) => entry.key));
		const after = new Set(surface.map((entry) => entry.key));
		const gained = surface.filter((entry) => !keys.has(entry.key));
		const lost = before.filter((entry) => !after.has(entry.key));
		if (gained.length === 0 && lost.length === 0) return null;
		return {
			gained: namesOf(gained),
			lost: namesOf(lost),
			boundInto: this.boundInto(module),
			heldBefore: file !== undefined,
			scopes: [],
		};
	}

	/** What the module lets another module bind to by declaration, as its rows hold it. */
	private surfaceHeld(module: string): SurfaceEntry[] {
		const rows = this.db
			.prepare(
				"SELECT symbolId, name, kind, languageKind, visibility, exported FROM symbols WHERE module = ? AND visibility <> 'local'",
			)
			.all(module) as Array<Omit<SurfaceRow, "exported"> & { exported: number | null }>;
		return rows.map((row) =>
			declarationEntry({ ...row, exported: row.exported === null ? null : row.exported === 1 }),
		);
	}

	/** Other modules with a reference bound to a declaration this module holds. */
	boundInto(module: string): string[] {
		const rows = this.db
			.prepare(
				`SELECT DISTINCT r.module FROM symbols s JOIN refs r ON r.targetId = s.symbolId
				 WHERE s.module = ? AND r.module <> ? ORDER BY r.module`,
			)
			.all(module, module) as Array<{ module: string }>;
		return rows.map((row) => row.module);
	}

	/** Adds a move to what the module's earlier writes left unasked. */
	private recordMove(module: string, change: SurfaceChange): void {
		const held = this.surfaceMovesOf([module]).get(module);
		const merged = (key: "gained" | "lost" | "boundInto" | "scopes") =>
			[...new Set([...(held?.[key] ?? []), ...change[key]])].sort();
		this.db
			.prepare(
				"INSERT OR REPLACE INTO surface_moves (module, gained, lost, boundInto, heldBefore, scopes) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(
				module,
				JSON.stringify(merged("gained")),
				JSON.stringify(merged("lost")),
				JSON.stringify(merged("boundInto")),
				held?.heldBefore === true || change.heldBefore ? 1 : 0,
				JSON.stringify(merged("scopes")),
			);
	}

	/** The moves writes left for `modules`, or for every module when null, still pending. */
	surfaceMovesOf(modules: readonly string[] | null): Map<string, SurfaceChange> {
		const columns = "SELECT module, gained, lost, boundInto, heldBefore, scopes FROM surface_moves";
		const rows = (
			modules === null
				? this.db.prepare(columns).all()
				: this.db
						.prepare(`${columns} WHERE module IN (SELECT value FROM json_each(?))`)
						.all(JSON.stringify(modules))
		) as Array<{
			module: string;
			gained: string;
			lost: string;
			boundInto: string;
			heldBefore: number;
			scopes: string;
		}>;
		return new Map(
			rows.map((row) => [
				row.module,
				{
					gained: JSON.parse(row.gained),
					lost: JSON.parse(row.lost),
					boundInto: JSON.parse(row.boundInto),
					heldBefore: row.heldBefore === 1,
					scopes: JSON.parse(row.scopes),
				},
			]),
		);
	}

	/**
	 * Writes the debt a road owes for moves it read, and acknowledges those moves, in one
	 * transaction, so a stop between the two leaves the move rather than losing both. A move a
	 * later write merged into since it was read stays pending.
	 */
	settleMoves(moves: ReadonlyMap<string, SurfaceChange>, owed: readonly string[]): void {
		const owe = this.db.prepare("INSERT OR IGNORE INTO rebind_owed (module) VALUES (?)");
		const acknowledge = this.db.prepare(
			`DELETE FROM surface_moves
			 WHERE module = ? AND gained = ? AND lost = ? AND boundInto = ? AND heldBefore = ? AND scopes = ?`,
		);
		this.indexWrite(() => {
			for (const module of owed) owe.run(module);
			for (const [module, change] of moves) {
				acknowledge.run(
					module,
					JSON.stringify(change.gained),
					JSON.stringify(change.lost),
					JSON.stringify(change.boundInto),
					change.heldBefore ? 1 : 0,
					JSON.stringify(change.scopes),
				);
			}
		});
	}

	////////////////////////////////
	//  Generations and projection

	/** The scope keys a module contributes to. */
	scopeKeysOf(module: string): string[] {
		return this.projectionQueries.scopeKeysOf(module);
	}

	/**
	 * Advances the store-wide facts generation and every scope the module touched, owes its
	 * projection, and records as moved the scopes it left or joined, or every one it touched when
	 * its surface moved, all in the caller's transaction.
	 * `heldBefore`: the index held the module before this write.
	 */
	private advanceGenerations(
		module: string,
		scopesBefore: readonly string[],
		heldBefore: boolean,
		surfaceMoved: boolean,
	): void {
		const before = new Set(scopesBefore);
		const after = new Set(this.scopeKeysOf(module));
		const touched = [...new Set([...before, ...after])].sort();
		this.advances++;
		this.db
			.prepare(
				`INSERT INTO meta (key, value) VALUES ('factsGeneration', '1')
				 ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1`,
			)
			.run();
		const bump = this.db.prepare(
			`INSERT INTO scope_generations (scopeKey, generation) VALUES (?, 1)
			 ON CONFLICT(scopeKey) DO UPDATE SET generation = generation + 1`,
		);
		for (const key of touched) bump.run(key);
		this.db
			.prepare(
				`INSERT INTO projection_debt (module, heldBefore) VALUES (?, ?)
				 ON CONFLICT(module) DO UPDATE SET heldBefore = MAX(heldBefore, excluded.heldBefore)`,
			)
			.run(module, heldBefore ? 1 : 0);
		// A forwarder from a touched scope reads its members; one landing on a module new to the index read none.
		this.oweForwarders(heldBefore ? null : module, touched);
		// A rewrite keeping its surface and its scopes moves nothing a scope's importer reads.
		const moved = surfaceMoved ? touched : touched.filter((key) => before.has(key) !== after.has(key));
		if (moved.length > 0) {
			this.recordMove(module, { gained: [], lost: [], boundInto: [], heldBefore, scopes: moved });
		}
	}

	/** Advanced by every fact admission, replacement and removal. */
	factsGeneration(): number {
		const row = this.db.prepare("SELECT value FROM meta WHERE key = 'factsGeneration'").get() as
			| { value: string }
			| undefined;
		return this.generation(row === undefined ? 0 : Number(row.value));
	}

	factsRevision(): number {
		const row = this.db.prepare("SELECT value FROM meta WHERE key = 'factsGeneration'").get() as
			| { value: string }
			| undefined;
		return row === undefined ? 0 : Number(row.value);
	}

	/** Advanced by every write a contributor to the scope makes. */
	scopeGeneration(key: string): number {
		const row = this.db.prepare("SELECT generation FROM scope_generations WHERE scopeKey = ?").get(key) as
			| { generation: number }
			| undefined;
		return this.generation(row?.generation ?? 0);
	}

	fileOf(module: string): { exportsKnown: boolean; allList: AllList | null } | null {
		return this.projectionQueries.fileOf(module);
	}

	exportsIn(module: string): StoredExport[] {
		return this.projectionQueries.exportsIn(module);
	}

	/** Export edges whose target is this declaration, or whose name a module exposes it under. */
	exportsOf(symbolId: string): StoredExport[] {
		return this.projectionQueries.exportsOf(symbolId);
	}

	importEdgeAt(module: string, span: Range): StoredImport | null {
		return this.projectionQueries.importEdgeAt(module, span);
	}

	exportedDeclarations(module: string): Array<{ symbolId: string; name: string }> {
		return this.projectionQueries.exportedDeclarations(module);
	}

	scopeMembers(landing: ScopeLanding): Array<{ symbolId: string; name: string }> | null {
		return this.projectionQueries.scopeMembers(landing);
	}

	scopeExports(landing: ScopeLanding): Array<{ module: string; edge: StoredExport }> {
		return this.projectionQueries.scopeExports(landing);
	}

	/** The effective exports settlement last committed for a module. */
	effectiveExportsOf(module: string): EffectiveExport[] {
		return this.projectionQueries.effectiveExportsOf(module);
	}

	nextProjectionDebt(): string | null {
		return this.projectionQueries.nextProjectionDebt();
	}

	/**
	 * Commits one module's recomputed projection and clears its debt. When it moved, records the
	 * names gained and lost, and owes a projection to every module forwarding from it.
	 */
	commitProjection(module: string, rows: readonly EffectiveExport[]): boolean {
		return this.indexWrite(() => {
			const previous = this.effectiveExportsOf(module);
			const before = new Set(previous.map(canonical));
			const after = new Set(rows.map(canonical));
			const owed = this.db.prepare("SELECT heldBefore FROM projection_debt WHERE module = ?").get(module) as
				| { heldBefore: number }
				| undefined;
			this.db.prepare("DELETE FROM projection_debt WHERE module = ?").run(module);
			const moved = before.size !== after.size || [...after].some((key) => !before.has(key));
			if (!moved) return false;
			// A plan that read these exports read them as of the module's stamp.
			this.db.prepare("UPDATE files SET indexedAt = ? WHERE module = ?").run(this.nextStamp(), module);
			this.db.prepare("DELETE FROM effective_exports WHERE module = ?").run(module);
			const insert = this.db.prepare(
				"INSERT INTO effective_exports (module, name, meaning, origin, originSymbolId, certainty) VALUES (?, ?, ?, ?, ?, ?)",
			);
			for (const row of rows) {
				insert.run(
					module,
					row.name,
					row.meaning === undefined ? null : JSON.stringify(row.meaning),
					JSON.stringify(row.origin),
					row.origin.kind === "symbol" ? row.origin.symbolId : null,
					JSON.stringify(row.certainty),
				);
			}
			// Names whose rows the other side lacks.
			const fresh = (keys: ReadonlySet<string>, from: readonly EffectiveExport[]) =>
				[
					...new Set(
						from.flatMap((row) => (row.name !== null && !keys.has(canonical(row)) ? [row.name] : [])),
					),
				].sort();
			this.recordMove(module, {
				gained: fresh(before, rows),
				lost: fresh(after, previous),
				boundInto: [],
				heldBefore: owed === undefined || owed.heldBefore === 1,
				scopes: [],
			});
			this.oweForwarders(module);
			return true;
		});
	}

	/** Owes a projection to every module forwarding from an import landing on `module` or on one of `scopes`. */
	private oweForwarders(module: string | null, scopes: readonly string[] = []): void {
		const owe = this.db.prepare(
			"INSERT INTO projection_debt (module, heldBefore) VALUES (?, 1) ON CONFLICT(module) DO UPDATE SET heldBefore = 1",
		);
		for (const forwarder of this.projectionQueries.forwardersOf(module, scopes)) owe.run(forwarder);
	}

	/** Recomputes every owed projection to a fixpoint; answers the modules whose exports moved. */
	settleProjections(): string[] {
		return settleProjections(this);
	}

	/** Owes each module a parse for its bindings until one reading references is admitted. */
	oweRebinds(modules: readonly string[]): void {
		this.settleMoves(new Map(), modules);
	}

	/** The first payable owed module after `after` in module order, or null. */
	owedRebindAfter(after: string | null): string | null {
		return this.projectionQueries.owedRebindAfter(after);
	}

	/** Holds a debt until `providerId` answers again, or `blockedIn` restarts, or the module's own parse lands. */
	blockRebind(module: string, providerId: string, blockedFor: "outage" | "refusal", blockedIn: string): void {
		const block = this.db.prepare(
			`INSERT INTO rebind_owed (module, blockedBy, blockedFor, blockedIn) VALUES (?, ?, ?, ?)
			 ON CONFLICT (module) DO UPDATE SET blockedBy = excluded.blockedBy, blockedFor = excluded.blockedFor,
			 blockedIn = excluded.blockedIn`,
		);
		this.indexWrite(() => block.run(module, providerId, blockedFor, blockedIn));
	}

	/** Debts held back by a failed parse, with who failed them and in which process. */
	blockedRebinds(): Array<{ module: string; blockedBy: string; blockedFor: string; blockedIn: string }> {
		return this.projectionQueries.blockedRebinds();
	}

	/** Which of these modules hold a debt their own refusal blocks. */
	refusalBlocked(modules: readonly string[]): string[] {
		return this.projectionQueries.refusalBlocked(modules);
	}

	/** Makes these held debts payable again. */
	unblockRebinds(modules: readonly string[]): void {
		const unblock = this.db.prepare(`${UNBLOCK} WHERE module = ?`);
		this.indexWrite(() => {
			for (const module of modules) unblock.run(module);
		});
	}

	/** Makes the debts one provider's outage held payable again, answering how many. */
	unblockOutages(providerId: string): number {
		const unblock = this.db.prepare(`${UNBLOCK} WHERE blockedBy = ? AND blockedFor = 'outage'`);
		return this.indexWrite(() => Number(unblock.run(providerId).changes));
	}

	/** Settles a debt nothing can pay: the module holds no facts to parse again. */
	clearRebind(module: string): void {
		const clear = this.db.prepare("DELETE FROM rebind_owed WHERE module = ?");
		this.indexWrite(() => clear.run(module));
	}

	/** Modules with an import that landed on, or reaches through, one of `targets` when written, by target. */
	importersLandedOn(targets: readonly string[]): Array<{ module: string; target: string }> {
		return this.projectionQueries.importersLandedOn(targets);
	}

	/** Modules with an import landing on one of these scopes, by scope. */
	importersOfScopes(keys: readonly string[]): Array<{ module: string; scope: string }> {
		return this.projectionQueries.importersOfScopes(keys);
	}

	/** Import edges that landed on `landing` when written: a module by its path, a scope by its key. */
	importEdgesLandingOn(landing: Landing): StoredImport[] {
		return this.projectionQueries.importEdgesLandingOn(landing);
	}

	/** Modules whose effective exports bind some name to this declaration. */
	modulesExposing(symbolId: string): string[] {
		return this.projectionQueries.modulesExposing(symbolId);
	}

	/** The scopes listing this declaration as a member. */
	scopesHolding(symbolId: string): ScopeLanding[] {
		return this.projectionQueries.scopesHolding(symbolId);
	}

	/** Modules exposing `landing` under some name, as a namespace or a module value. */
	modulesHoldingNamespace(landing: Landing): string[] {
		return this.projectionQueries.modulesHoldingNamespace(landing);
	}

	/** Modules with an unbound reference spelled as one of `names`, by name. */
	modulesWithUnbound(names: readonly string[]): Array<{ module: string; name: string }> {
		return this.projectionQueries.modulesWithUnbound(names);
	}

	/** Every import edge that states a load and lands on a module, in one read. */
	loadEdges(): Array<{
		module: string;
		target: string;
		span: Range;
		loads: "static" | "deferred";
		elided?: boolean;
		typeOnly: boolean;
	}> {
		return this.projectionQueries.loadEdges();
	}

	/** Each module's distinct import specifiers and modes, for asking where each lands. */
	importEdges(): Array<{ module: string; specifier: string; resolutionMode?: ResolutionMode }> {
		return this.projectionQueries.importEdges();
	}

	/** Removes deleted file rows; admission determines purge debt. */
	forgetFile(module: string, admission: SecretAdmission): boolean {
		IndexStore.assertAdmissionFor(module, admission);
		return this.owingWrite((armed) => {
			this.armIfOwed(admission, [HELD_FACTS, HELD_FAILURE], armed);
			return this.forgetFileRows(module);
		});
	}

	private forgetFileRows(module: string): boolean {
		// Read while the rows it asks about still exist.
		const lost = namesOf(this.surfaceHeld(module));
		const boundInto = this.boundInto(module);
		const scopesBefore = this.scopeKeysOf(module);
		let removed = false;
		let held = false;
		for (const table of FACT_TABLES) {
			if (this.db.prepare(`DELETE FROM ${table} WHERE module = ?`).run(module).changes > 0) removed = true;
		}
		if (this.db.prepare("DELETE FROM files WHERE module = ?").run(module).changes > 0) held = true;
		if (this.db.prepare("DELETE FROM parse_failures WHERE module = ?").run(module).changes > 0) removed = true;
		// A module the index no longer holds owes nothing.
		this.db.prepare("DELETE FROM rebind_owed WHERE module = ?").run(module);
		if (removed || held) {
			this.recordMove(module, { gained: [], lost, boundInto, heldBefore: held, scopes: [] });
			this.advanceGenerations(module, scopesBefore, held, true);
			// What forwarded from it now lands on nothing the index holds.
			this.oweForwarders(module);
		}
		return removed || held;
	}

	fileNotes(module: string): FileNotes {
		const file = this.db.prepare("SELECT indexedAt FROM files WHERE module = ?").get(module) as
			| { indexedAt: number }
			| undefined;
		if (file === undefined) return { module, known: false, reason: "notIndexed" };
		if (file.indexedAt < this.notesSince()) return { module, known: false, reason: "indexedBeforeNotes" };
		const rows = this.db
			.prepare(
				"SELECT severity, message, path, startLine, startChar, endLine, endChar FROM notes WHERE module = ? ORDER BY ordinal",
			)
			.all(module) as unknown as NoteRow[];
		return { module, known: true, notes: rows.map(rowToNote) };
	}

	private notesSince(): number {
		return Number(readMeta(this.db, NOTES_SINCE_KEY) ?? 0);
	}

	/** Files carrying notes, and files read before notes were kept. */
	noteTotals(): { noted: number; unknown: number } {
		const one = (sql: string, ...args: number[]) => (this.db.prepare(sql).get(...args) as { n: number }).n;
		return {
			noted: one("SELECT COUNT(DISTINCT module) AS n FROM notes"),
			unknown: one("SELECT COUNT(*) AS n FROM files WHERE indexedAt < ?", this.notesSince()),
		};
	}

	/** Fills a row written before content was recorded. A recorded class is never overwritten here. */
	recordContent(module: string, content: FileContent): void {
		const record = this.db.prepare(
			"UPDATE files SET content = CASE WHEN content IS NULL THEN ? ELSE content END WHERE module = ?",
		);
		this.indexWrite(() => record.run(content, module));
	}

	/** Recorded module owners. */
	writers(): Map<string, string> {
		const rows = this.db.prepare("SELECT module, provider FROM files WHERE provider IS NOT NULL").all() as Array<{
			module: string;
			provider: string;
		}>;
		return new Map(rows.map((row) => [row.module, row.provider]));
	}

	/** Recorded provider id, if any. */
	writerOf(module: string): string | null {
		const row = this.db.prepare("SELECT provider FROM files WHERE module = ?").get(module) as
			| { provider: string | null }
			| undefined;
		return row?.provider ?? null;
	}

	/** The depth a module's stored facts were extracted at, or null when it is not indexed. */
	depthOf(module: string): IndexDepth | null {
		const row = this.db.prepare("SELECT depth FROM files WHERE module = ?").get(module) as
			| { depth: IndexDepth }
			| undefined;
		return row?.depth ?? null;
	}

	moduleRuntime(module: string): "esm" | "cjs" | null {
		const row = this.db.prepare("SELECT runtime FROM files WHERE module = ?").get(module) as
			| { runtime: "esm" | "cjs" | null }
			| undefined;
		return row?.runtime ?? null;
	}

	/** Each module's runtime, null where none was reported, in one read. */
	runtimesOf(modules: readonly string[]): Map<string, "esm" | "cjs" | null> {
		const rows = this.db
			.prepare("SELECT module, runtime FROM files WHERE module IN (SELECT value FROM json_each(?))")
			.all(JSON.stringify(modules)) as Array<{ module: string; runtime: "esm" | "cjs" | null }>;
		return new Map(rows.map((row) => [row.module, row.runtime]));
	}

	/**
	 * How many uses in `modules` each import edge carries, bound or not, by module and edge span, in
	 * one read. Roles in `skip` are left out.
	 */
	importUseCounts(
		modules: readonly string[],
		skip: readonly ReferenceRole[],
	): Array<{ module: string; origin: Range; count: number }> {
		return this.factQueries.importUseCounts(modules, skip);
	}

	/** The first `limit` uses in `module` through the import edge spanning `origin`, roles in `skip` aside. */
	importUsesThrough(
		module: string,
		origin: Range,
		skip: readonly ReferenceRole[],
		limit: number,
	): Array<{ name: string; range: Range }> {
		return this.factQueries.importUsesThrough(module, origin, skip, limit);
	}

	/** Null means no role was reported. */
	roleOf(module: string): FileRole | null {
		const row = this.db
			.prepare("SELECT role, roleHow, roleSymbolId, roleReason FROM files WHERE module = ?")
			.get(module) as RoleRow | undefined;
		return row === undefined ? null : roleFromRow(row);
	}

	/**
	 * Entry files in scope, capped by `limit`. Null means no role was reported.
	 */
	entryPoints(include: (module: string) => boolean, limit: number): { entries: EntryPoint[]; more: number } | null {
		const rows = this.db
			.prepare(
				"SELECT module, role, roleHow, roleSymbolId, roleReason FROM files WHERE role IS NOT NULL ORDER BY module",
			)
			.iterate() as Iterable<RoleRow & { module: string }>;
		let reported = false;
		let more = 0;
		const entries: EntryPoint[] = [];
		for (const row of rows) {
			if (!include(row.module)) continue;
			const role = roleFromRow(row);
			if (role === null) continue;
			reported = true;
			if (role.kind !== "entry") continue;
			if (entries.length === limit) {
				more++;
				continue;
			}
			entries.push(
				role.how === "main"
					? { module: row.module, how: role.how, symbolId: role.symbolId }
					: { module: row.module, how: role.how },
			);
		}
		return reported ? { entries, more } : null;
	}

	/** What a module's rows were committed as, or null when it is not indexed. */
	stampOf(module: string): FactsStamp | null {
		const row = this.db.prepare("SELECT depth, indexedAt FROM files WHERE module = ?").get(module) as
			| FactsStamp
			| undefined;
		return row ?? null;
	}

	/** Modules still owing a full pass, in module order for deterministic upgrades. */
	outlineModules(): string[] {
		return (
			this.db.prepare("SELECT module FROM files WHERE depth = 'outline' ORDER BY module").all() as Array<{
				module: string;
			}>
		).map((row) => row.module);
	}

	/** How many stored files hold facts at each depth, for coverage reporting. */
	depthTotals(): { full: number; surface: number; outline: number } {
		const rows = this.db.prepare("SELECT depth, COUNT(*) AS n FROM files GROUP BY depth").all() as Array<{
			depth: string;
			n: number;
		}>;
		const totals = { full: 0, surface: 0, outline: 0 };
		for (const row of rows) {
			if (row.depth === "full" || row.depth === "surface" || row.depth === "outline") totals[row.depth] = row.n;
		}
		return totals;
	}

	/** Remembers a parse failure so coverage can name it after this process is gone. */
	recordFailure(module: string, reason: StoredFailure, admission: SecretAdmission): void {
		IndexStore.assertAdmissionFor(module, admission);
		const record = this.db.prepare(
			"INSERT OR REPLACE INTO parse_failures (module, reason, failedAt, policyStamp, admittedAs) VALUES (?, ?, ?, ?, ?)",
		);
		this.owingWrite((armed) => {
			this.armIfOwed(admission, [HELD_FAILURE], armed);
			record.run(module, reason, this.clock.now(), admission.stamp, admittedAsOf(admission));
		});
	}

	policyStampsOf(
		modules: readonly string[],
		prefixes: readonly string[],
	): Array<{ module: string; stamp: string | null }> {
		if (prefixes.includes(""))
			return this.db
				.prepare(
					`SELECT module, stamp FROM (
						SELECT module, policyStamp AS stamp FROM files
						UNION
						SELECT module, policyStamp AS stamp FROM parse_failures
					) ORDER BY module`,
				)
				.all() as Array<{ module: string; stamp: string | null }>;
		const rows = new Map<string, string | null>();
		const read = (clauses: string[], values: string[]) => {
			if (clauses.length === 0) return;
			const found = this.db
				.prepare(
					`SELECT module, stamp FROM (
						SELECT module, policyStamp AS stamp FROM files
						UNION
						SELECT module, policyStamp AS stamp FROM parse_failures
					) WHERE ${clauses.join(" OR ")} ORDER BY module`,
				)
				.all(...values) as Array<{ module: string; stamp: string | null }>;
			for (const row of found) rows.set(row.module, row.stamp);
		};
		for (let start = 0; start < modules.length; start += 400) {
			const chunk = modules.slice(start, start + 400);
			read([`module IN (${chunk.map(() => "?").join(", ")})`], [...chunk]);
		}
		for (let start = 0; start < prefixes.length; start += 100) {
			const chunk = prefixes.slice(start, start + 100);
			const clauses = chunk.flatMap(() => ["module = ?", "substr(module, 1, length(?)) = ?"]);
			const values = chunk.flatMap((prefix) => [prefix, `${prefix}/`, `${prefix}/`]);
			read(clauses, values);
		}
		return [...rows]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([module, stamp]) => ({ module, stamp }));
	}

	clearFailure(module: string, admission: SecretAdmission): void {
		IndexStore.assertAdmissionFor(module, admission);
		const clear = this.db.prepare("DELETE FROM parse_failures WHERE module = ?");
		this.owingWrite((armed) => {
			this.armIfOwed(admission, [HELD_FAILURE], armed);
			clear.run(module);
		});
	}

	parseFailureCount(): number {
		return (this.db.prepare("SELECT COUNT(*) AS n FROM parse_failures").get() as { n: number }).n;
	}

	/** By path, so a sample and the full list agree on order. */
	parseFailures(limit?: number): Array<{ module: string; reason: string }> {
		const rows =
			limit === undefined
				? this.db.prepare("SELECT module, reason FROM parse_failures ORDER BY module").all()
				: this.db.prepare("SELECT module, reason FROM parse_failures ORDER BY module LIMIT ?").all(limit);
		return rows as Array<{ module: string; reason: string }>;
	}

	parseFailureOf(module: string): { module: string; reason: string } | null {
		const row = this.db.prepare("SELECT module, reason FROM parse_failures WHERE module = ?").get(module) as
			| { module: string; reason: string }
			| undefined;
		return row ?? null;
	}

	/** The project fingerprint a provider's stored facts were parsed under; null when it gave none. */
	projectFingerprint(providerId: string): string | null {
		return readMeta(this.db, `${PROJECT_FINGERPRINT_KEY}:${providerId}`);
	}

	lastSecretPolicy(): StoredSecretPolicy | null {
		const raw = readMeta(this.db, SECRET_POLICY_KEY);
		if (raw === null) return null;
		try {
			const parsed = JSON.parse(raw) as { secrets?: unknown; deny?: unknown };
			const secrets = SecretsConfigSchema.safeParse(parsed.secrets);
			if (
				!secrets.success ||
				!Array.isArray(parsed.deny) ||
				!parsed.deny.every((glob) => typeof glob === "string")
			)
				return null;
			return { secrets: secrets.data, deny: parsed.deny as string[] };
		} catch {
			return null;
		}
	}

	rememberSecretPolicy(policy: StoredSecretPolicy): void {
		const encoded = JSON.stringify(policy);
		if (readMeta(this.db, SECRET_POLICY_KEY) === encoded) return;
		this.indexWrite(() => writeMeta(this.db, SECRET_POLICY_KEY, encoded));
	}

	/** An index write, so it never lands while a batch holding the parses under it is lost. */
	recordProjectFingerprint(providerId: string, fingerprint: string): void {
		this.indexWrite(() => writeMeta(this.db, `${PROJECT_FINGERPRINT_KEY}:${providerId}`, fingerprint));
	}

	/** Persists scan counts used to explain coverage gaps; an index write, as the fingerprint is. */
	writeScanSummary(summary: ScanCounts): void {
		this.indexWrite(() =>
			writeMeta(this.db, SCAN_SUMMARY_KEY, JSON.stringify({ ...summary, at: this.clock.now() })),
		);
	}

	/** One bounded sweep, one transaction, resuming from the cursor the last one persisted. */
	sweepSubjects(batch: number, pass: SweepPass, now: number): SweepReport {
		const report = this.inTransaction(() => {
			const { report, cursor } = this.subjects.sweepSubjects(batch, pass, now, readSweepCursor(this.db));
			writeMeta(this.db, SWEEP_CURSOR_KEY, JSON.stringify(cursor));
			return report;
		});
		return report;
	}

	readScanSummary(): (ScanCounts & { at: number }) | null {
		const raw = readMeta(this.db, SCAN_SUMMARY_KEY);
		if (raw === null) return null;
		try {
			const parsed = JSON.parse(raw) as Partial<ScanCounts> & { at?: number };
			// Every part or none. A defaulted field would print arithmetic that does not sum.
			const parts = [parsed.tracked, parsed.claimed, parsed.unclaimed, parsed.generated, parsed.denied];
			if (parts.some((part) => typeof part !== "number")) return null;
			return {
				tracked: parsed.tracked as number,
				claimed: parsed.claimed as number,
				unclaimed: parsed.unclaimed as number,
				generated: parsed.generated as number,
				denied: parsed.denied as number,
				outlined: parsed.outlined === true,
				...(sweepReportOf(parsed.knowledgeSweep) === null
					? {}
					: { knowledgeSweep: sweepReportOf(parsed.knowledgeSweep) as SweepReport }),
				at: parsed.at ?? 0,
			};
		} catch {
			return null;
		}
	}

	////////////////////////////////
	//  Refactor journal
	//
	// Store owns journal rows; TransactionManager owns their meaning.

	/** Runs a journal read in a store-owned transaction. */
	journalRead<T>(work: (db: Database) => T): T {
		return this.inTransaction(() => work(this.db));
	}

	/** Runs a journal write in a store-owned transaction. */
	journalWrite<T>(work: (db: Database) => T): T {
		return this.inTransaction(() => work(this.db));
	}

	/** Legacy fixture access. Production code uses journalRead or journalWrite. */
	journal<T>(work: (db: Database) => T): T {
		return this.journalRead(work);
	}

	/** Stores by hash, so repeats write no bytes. Durable on return. */
	putBlob(admitted: AdmittedBytes): void {
		this.inTransaction(() => this.putBlobWithin(this.db, admitted));
	}

	/** Stores admitted bytes in the active transaction. */
	putBlobWithin(db: Database, admitted: AdmittedBytes): void {
		this.admitWithin(db, admitted);
		db.prepare("INSERT OR IGNORE INTO refactor_blobs (hash, bytes) VALUES (?, ?)").run(
			admitted.hash,
			admitted.bytes,
		);
	}

	/** Stores one image admission. */
	admit(admission: JournalAdmission): void {
		this.inTransaction(() => this.admitWithin(this.db, admission));
	}

	/** Stores admission in the active transaction. */
	admitWithin(db: Database, admission: JournalAdmission): void {
		db.prepare(
			`INSERT INTO refactor_admissions (module, hash, stamp) VALUES (?, ?, ?)
			 ON CONFLICT(module, hash) DO UPDATE SET stamp = excluded.stamp`,
		).run(admission.module, admission.hash, admission.stamp);
	}

	/** Reads retained image bytes. */
	heldImage(module: string, hash: string): HeldJournalImage | null {
		const row = this.db
			.prepare(
				`SELECT admissions.module, admissions.hash, admissions.stamp, blobs.bytes
				 FROM refactor_admissions AS admissions
				 LEFT JOIN refactor_blobs AS blobs ON blobs.hash = admissions.hash
				 WHERE admissions.module = ? AND admissions.hash = ?`,
			)
			.get(module, hash) as HeldJournalImage | undefined;
		return row ?? null;
	}

	/** Lists admitted image pairs. */
	admissions(): StoredAdmission[] {
		return this.db
			.prepare("SELECT module, hash, stamp FROM refactor_admissions ORDER BY module, hash")
			.all() as unknown as StoredAdmission[];
	}

	/** Updates an admission stamp. */
	restamp(admission: JournalAdmission): boolean {
		return this.inTransaction(() => {
			const result = this.db
				.prepare("UPDATE refactor_admissions SET stamp = ? WHERE module = ? AND hash = ?")
				.run(admission.stamp, admission.module, admission.hash);
			return Number(result.changes) > 0;
		});
	}

	/** Finds missing admissions. */
	unadmittedReferences(): UnadmittedJournalReference[] {
		return this.db
			.prepare(
				`SELECT refs.module, refs.hash FROM (${keptHashPairs()}) AS refs
				 WHERE NOT EXISTS (
				   SELECT 1 FROM refactor_admissions AS admissions
				   WHERE admissions.module = refs.module AND admissions.hash = refs.hash
				 )
			 ORDER BY refs.module, refs.hash`,
			)
			.all() as unknown as UnadmittedJournalReference[];
	}

	/** Prunes unused admissions. */
	pruneAdmissionsWithin(db: Database): number {
		const result = db
			.prepare(
				`DELETE FROM refactor_admissions
				 WHERE NOT EXISTS (
				   SELECT 1 FROM (${keptHashPairs()}) AS refs
				   WHERE refs.module = refactor_admissions.module AND refs.hash = refactor_admissions.hash
				 )`,
			)
			.run();
		return Number(result.changes);
	}

	/** Prunes unreferenced blobs after settlement. */
	pruneBlobs(): number {
		return this.inTransaction(() => this.pruneUnkept());
	}

	/**
	 * Drops image journals and arms WAL purge debt.
	 */
	purgeImages(pairs: readonly Pick<StoredAdmission, "module" | "hash">[]): number {
		try {
			return this.inTransaction(() => {
				this.purge.arm();
				let removed = 0;
				const units = new Map<string, Set<string>>();
				const unique = new Map(pairs.map((pair) => [`${pair.module}\u0000${pair.hash}`, pair]));
				for (const { module, hash } of unique.values()) {
					removed += this.purgeJsonReferences(this.db, module, hash);
					for (const table of JOURNAL_TABLE_NAMES) {
						const entry: JournalTable = JOURNAL_TABLES[table];
						const columns = entry.hashes;
						if (columns?.transaction === undefined) continue;
						const named = columns.columns.map((column) => `${column} = ?`).join(" OR ");
						const transactions = this.db
							.prepare(
								`SELECT DISTINCT ${columns.transaction} AS transactionId FROM ${table}
								 WHERE ${columns.module} = ? AND (${named})`,
							)
							.all(module, ...columns.columns.map(() => hash)) as Array<{ transactionId: string }>;
						for (const row of transactions) {
							const modules = units.get(row.transactionId) ?? new Set<string>();
							modules.add(module);
							units.set(row.transactionId, modules);
						}
					}
					for (const table of JOURNAL_TABLE_NAMES) {
						const entry: JournalTable = JOURNAL_TABLES[table];
						const columns = entry.hashes;
						if (columns?.transaction !== undefined) continue;
						if (columns === undefined) continue;
						const named = columns.columns.map((column) => `${column} = ?`).join(" OR ");
						removed += Number(
							this.db
								.prepare(`DELETE FROM ${table} WHERE ${columns.module} = ? AND (${named})`)
								.run(module, ...columns.columns.map(() => hash)).changes,
						);
					}
				}
				for (const [transactionId, modules] of units) {
					for (const module of modules) {
						for (const table of JOURNAL_TABLE_NAMES) {
							const entry: JournalTable = JOURNAL_TABLES[table];
							const columns = entry.hashes;
							if (columns?.transaction === undefined) continue;
							removed += Number(
								this.db
									.prepare(
										`DELETE FROM ${table} WHERE ${columns.transaction} = ? AND ${columns.module} = ?`,
									)
									.run(transactionId, module).changes,
							);
						}
						const intent = this.db
							.prepare("SELECT diskStates FROM refactor_recovery_intents WHERE transactionId = ?")
							.get(transactionId) as { diskStates: string | null } | undefined;
						if (intent?.diskStates === null || intent === undefined) continue;
						try {
							const states: unknown = JSON.parse(intent.diskStates);
							if (!Array.isArray(states)) continue;
							const remaining = states.filter(
								(state) =>
									typeof state !== "object" ||
									state === null ||
									!("module" in state) ||
									state.module !== module,
							);
							this.db
								.prepare("UPDATE refactor_recovery_intents SET diskStates = ? WHERE transactionId = ?")
								.run(JSON.stringify(remaining), transactionId);
						} catch {}
					}
				}
				this.pruneUnkept();
				return removed;
			});
		} finally {
			this.purge.settle(true);
		}
	}

	private purgeJsonReferences(db: Database, module: string, hash: string): number {
		let rewritten = 0;
		for (const table of JOURNAL_TABLE_NAMES) {
			const entry: JournalTable = JOURNAL_TABLES[table];
			for (const reference of entry.jsonHashes ?? []) {
				const rows = db
					.prepare(
						`SELECT ${reference.key} AS key, ${reference.column} AS value
						 FROM ${table} WHERE ${reference.column} IS NOT NULL`,
					)
					.all() as Array<{ key: string; value: string }>;
				for (const row of rows) {
					const parsed: unknown = JSON.parse(row.value);
					const entries = jsonArrayAt(parsed, reference.array);
					if (entries === null) continue;
					let changed = false;
					for (let index = entries.length - 1; index >= 0; index--) {
						const entry = entries[index];
						if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
						const record = entry as Record<string, unknown>;
						if (record[reference.module] !== module) continue;
						if (!reference.hashes.some((column) => record[column] === hash)) continue;
						if (reference.purge === "remove") entries.splice(index, 1);
						else {
							for (const column of reference.hashes) if (record[column] === hash) record[column] = null;
						}
						changed = true;
					}
					if (!changed) continue;
					db.prepare(`UPDATE ${table} SET ${reference.column} = ? WHERE ${reference.key} = ?`).run(
						JSON.stringify(parsed),
						row.key,
					);
					rewritten++;
				}
			}
		}
		return rewritten;
	}

	private pruneUnkept(): number {
		this.pruneAdmissionsWithin(this.db);
		const result = this.db.prepare(`DELETE FROM refactor_blobs WHERE hash NOT IN (${keptBlobs()})`).run();
		return Number(result.changes);
	}

	/** Ledger identity survives store rebuilds. */
	refactorLedgerId(): string {
		const id = readMeta(this.db, LEDGER_KEY);
		if (id === null) throw new Error("the store has no settlement ledger id");
		return id;
	}

	/**
	 * The fact one id names, or null when it names nothing any more.
	 *
	 * Null IS the staleness signal. A fact id is a digest of the fact's own contents, so an id that
	 * no longer resolves is exactly a fact that changed or vanished, and a citation holder needs no
	 * second hash to compare.
	 */
	factById(factId: string): StoredFact | null {
		return this.factQueries.factById(factId);
	}

	////////////////////////////////
	//  Knowledge

	/** Knowledge-changing write count. */
	knowledgeGeneration(): number {
		return this.knowledgeTurns;
	}

	/** A declaration's pattern digest and what it covers, or null before a full parse minted one. */
	patternDigestOf(symbolId: string): { digest: string; coverage: string } | null {
		return this.factQueries.patternDigestOf(symbolId);
	}

	/** Every symbol id the index holds for one module, which is the subtree a rename re-mints. */
	symbolIdsIn(module: string): string[] {
		return this.factQueries.symbolIdsIn(module);
	}

	////////////////////////////////
	//  Reading

	contentHashOf(module: string): string | null {
		return this.factQueries.contentHashOf(module);
	}

	policyStampOf(module: string): string | null {
		const row = this.db.prepare("SELECT policyStamp FROM files WHERE module = ?").get(module) as
			| { policyStamp: string | null }
			| undefined;
		return row?.policyStamp ?? null;
	}

	newestIndexedAt(): number | null {
		return this.factQueries.newestIndexedAt();
	}

	declaration(symbolId: string): StoredDeclaration | null {
		return this.factQueries.declaration(symbolId);
	}

	declarationsIn(module: string): StoredDeclaration[] {
		return this.factQueries.declarationsIn(module);
	}

	/** Mentions included; see usesTo. */
	referencesTo(symbolId: string): StoredReference[] {
		return this.factQueries.referencesTo(symbolId);
	}

	/** Why the storage exists. */
	usesTo(symbolId: string): StoredReference[] {
		return this.factQueries.usesTo(symbolId);
	}

	/** Use counts per declaration, in one read; unused is absent. */
	useCountsIn(module: string): Map<string, number> {
		return this.factQueries.useCountsIn(module);
	}

	/** Distinct using declarations per symbol; top-level uses count their module, and unused symbols are absent. */
	holderCounts(symbolIds: readonly string[]): Map<string, number> {
		return this.factQueries.holderCounts(symbolIds);
	}

	/** Whether a module's path reads as a test, by the rule name searches rank with. */
	testModule(module: string): boolean {
		return this.factQueries.testModule(module);
	}

	/** Each other module using something `module` declares, with up to three of those, `except` aside. */
	usesInto(module: string, except: string): Map<string, string[]> {
		return this.factQueries.usesInto(module, except);
	}

	/** Whether `module` uses the symbol. */
	moduleUses(module: string, symbolId: string): boolean {
		return this.factQueries.moduleUses(module, symbolId);
	}

	/** Use counts for a symbol, grouped by module. */
	usingModules(symbolId: string): Map<string, number> {
		return this.factQueries.usingModules(symbolId);
	}

	/** Distinct resolved import targets for a module. */
	importTargets(module: string): string[] {
		return this.factQueries.importTargets(module);
	}

	/** Modules with at least one declaration marked exported by its provider. */
	exportingModules(): string[] {
		return this.factQueries.exportingModules();
	}

	/** Mentions included; see usesIn. */
	referencesIn(module: string): StoredReference[] {
		return this.factQueries.referencesIn(module);
	}

	/** Includes unbound rows too. */
	usesIn(module: string): StoredReference[] {
		return this.factQueries.usesIn(module);
	}

	/**
	 * Occurrences spelled like this that did NOT bind to the given symbol.
	 *
	 * The set a rename has to worry about. Some are genuinely other symbols and some are uses of
	 * this one that binding could not follow, and nothing here can tell those apart, which is
	 * precisely why they are returned rather than filtered away.
	 */
	referencesSpelled(name: string, excludingTarget: string): StoredReference[] {
		return this.factQueries.referencesSpelled(name, excludingTarget);
	}

	/**
	 * Every import that writes this name, anywhere in the workspace.
	 *
	 * Returned unresolved. Whether one of these refers to a particular symbol depends on where its
	 * specifier lands, which only a provider can say, and asking about every import in the workspace
	 * to answer about one symbol would be the wrong trade.
	 */
	importsNamed(name: string): StoredImport[] {
		return this.factQueries.importsNamed(name);
	}

	/**
	 * Imports that BIND this name in the importing file, which is not the same question as `importsNamed`.
	 *
	 * `import { a as bar }` is named `a` and binds `bar`. A collision check cares about what the file
	 * calls it, and a rename of the source symbol cares about what the source module calls it, so the
	 * two questions read the same table through different columns.
	 */
	importsBinding(localName: string): StoredImport[] {
		return this.factQueries.importsBinding(localName);
	}

	importsIn(module: string): StoredImport[] {
		return this.factQueries.importsIn(module);
	}

	/** Each module whose effective exports name `name`, with what it binds to there. */
	exposuresNamed(name: string): Array<{ module: string; originSymbolId: string | null }> {
		return this.factQueries.exposuresNamed(name);
	}

	/** Where `specifier` landed from `module` in `mode` when it was written; null when unknown. */
	importLanding(module: string, specifier: string, mode: ResolutionMode | undefined): Landing | null {
		return this.factQueries.importLanding(module, specifier, mode);
	}

	/**
	 * The declaration `name` means in `module`, through its effective exports. Null when nothing
	 * exports it, or it names a namespace or a module value.
	 */
	exportedSymbol(module: string, name: string): string | null {
		return this.factQueries.exportedSymbol(module, name);
	}

	/** Import rows for bounded application-side searches. */
	importsForScan(scanLimit: number, hidden: HiddenModules): StoredImport[] {
		return this.factQueries.importsForScan(scanLimit, hidden);
	}

	/** Search declarations by name substring or regular expression. */
	searchSymbols(
		text: string | undefined,
		options: {
			regex?: string | undefined;
			kind?: string;
			module?: string;
			limit: number;
			scope?: ScopeFilter;
			hidden: HiddenModules;
		},
	): StoredDeclaration[] {
		return this.searchQueries.searchSymbols(text, options);
	}

	/** Declarations whose name contains `text`, any case: own code, then top-level, then exact names, then
	 * prefixes, then shortest. */
	symbolsNamedLike(text: string, limit: number, offset = 0, kinds?: readonly string[]): StoredDeclaration[] {
		return this.searchQueries.symbolsNamedLike(text, limit, offset, kinds);
	}

	/** Indexed files whose path contains `text`, any case: own code, then a name starting with it, then shortest. */
	filesNamedLike(text: string, limit: number): string[] {
		return this.searchQueries.filesNamedLike(text, limit);
	}

	/** Imports whose specifier contains this text. "Which files import X", by the name as written. */
	importsMatching(specifier: string, limit: number, hidden: HiddenModules): StoredImport[] {
		return this.searchQueries.importsMatching(specifier, limit, hidden);
	}

	/** Every module held by the index, including files with no declarations. */
	indexedFiles(): string[] {
		return this.searchQueries.indexedFiles();
	}

	/** Modules `exclude` hides, for this hold's searches. */
	hiddenModules(exclude: ModuleExclusion | undefined): HiddenModules {
		return this.searchQueries.hiddenModules(exclude);
	}

	/** Every module with facts, ordered by symbol count. Content is null on a row written before it was kept. */
	moduleSummary(): Array<{ module: string; symbols: number; content: FileContent | null }> {
		return this.searchQueries.moduleSummary();
	}

	/** Files and symbols per content class, over the modules a live workspace predicate admits. */
	contentTotals(includeModule: (module: string) => boolean): ContentTotals {
		return this.searchQueries.contentTotals(includeModule);
	}

	/** Counts for an overview, in one round trip rather than five. */
	totals(): { files: number; symbols: number; references: number; imports: number; literals: number } {
		return this.searchQueries.totals();
	}

	/**
	 * The symbol count split by kind, so one total cannot mean two things.
	 *
	 * A document's headings and keys are symbols and belong in the count, but a reader taking that
	 * count for callable code is reading it wrong once any document is indexed. Split rather than
	 * filtered, because which kinds are code is the caller's question and not this table's.
	 */
	symbolsByKind(): Record<string, number> {
		return this.searchQueries.symbolsByKind();
	}

	/** Counts facts whose modules satisfy a live workspace predicate. */
	totalsForModules(includeModule: (module: string) => boolean): {
		files: number;
		symbols: number;
		references: number;
		imports: number;
		literals: number;
	} {
		return this.searchQueries.totalsForModules(includeModule);
	}

	/** Every symbol with a given name, across the workspace. The entry point for a name-only ask. */
	declarationsNamed(name: string): StoredDeclaration[] {
		return this.searchQueries.declarationsNamed(name);
	}

	////////////////////////////////
	//  Literals

	literalsWhere(filter: LiteralFilter, limit: number): StoredLiteral[] {
		return this.searchQueries.literalsWhere(filter, limit);
	}

	countLiteralsWhere(filter: LiteralFilter): number {
		return this.searchQueries.countLiteralsWhere(filter);
	}

	/** Every literal in one module, matching declarationsIn and referencesIn. */
	literalsIn(module: string): StoredLiteral[] {
		return this.searchQueries.literalsIn(module);
	}

	////////////////////////////////
	//  Comments

	/** Substring over the NORMALIZED text, so a phrase the writer wrapped still matches. */
	commentsContaining(text: string, limit: number, filter: CommentFilter): StoredComment[] {
		return this.searchQueries.commentsContaining(text, limit, filter);
	}

	/** The true count, so a page never reports its own cap as a total. */
	countCommentsContaining(text: string, filter: CommentFilter): number {
		return this.searchQueries.countCommentsContaining(text, filter);
	}

	/** Every comment a caller must match itself, for the same reason literals need one: no REGEXP. */
	commentsToScan(scanLimit: number, filter: CommentFilter): StoredComment[] {
		return this.searchQueries.commentsToScan(scanLimit, filter);
	}

	countComments(filter: CommentFilter): number {
		return this.searchQueries.countComments(filter);
	}

	/** What is written about one symbol, which is how describe gets its documentation. */
	commentsAnchoredTo(symbolId: string): StoredComment[] {
		return this.searchQueries.commentsAnchoredTo(symbolId);
	}

	/** Every comment in one module, matching declarationsIn and referencesIn. */
	commentsIn(module: string): StoredComment[] {
		return this.searchQueries.commentsIn(module);
	}

	////////////////////////////////
	//  Documents

	docsContaining(text: string, limit: number, filter: DocFilter): StoredDoc[] {
		return this.searchQueries.docsContaining(text, limit, filter);
	}

	/** The true count, so a page never reports its own cap as a total. */
	countDocsContaining(text: string, filter: DocFilter): number {
		return this.searchQueries.countDocsContaining(text, filter);
	}

	/** Every region a caller must match itself, for the same reason comments need one: no REGEXP. */
	docsToScan(scanLimit: number, filter: DocFilter): StoredDoc[] {
		return this.searchQueries.docsToScan(scanLimit, filter);
	}

	countDocs(filter: DocFilter): number {
		return this.searchQueries.countDocs(filter);
	}

	/** The prose of one section, which is how describe answers about a heading. */
	docsAnchoredTo(symbolId: string): StoredDoc[] {
		return this.searchQueries.docsAnchoredTo(symbolId);
	}

	/**
	 * Values written in more than one file, commonest first.
	 *
	 * The whole point of the tier: a magic string shared by two files is the strongest textual
	 * signal that they are related, and no graph edge connects them.
	 */
	sharedLiterals(
		minimumFiles: number,
		limit: number,
		hidden: HiddenModules,
	): Array<{ value: string; kind: string; files: number; uses: number }> {
		return this.searchQueries.sharedLiterals(minimumFiles, limit, hidden);
	}

	////////////////////////////////
	//  Graph

	/** Bound rows only; fan-out. */
	usesFrom(symbolId: string): StoredReference[] {
		return this.searchQueries.usesFrom(symbolId);
	}

	/** Distinct bound targets used from any of `fromIds`, in one read however many there are. */
	targetsFrom(fromIds: readonly string[]): Set<string> {
		return this.searchQueries.targetsFrom(fromIds);
	}

	/** Distinct bound targets a module's top level uses. */
	topLevelTargets(module: string): Set<string> {
		return this.searchQueries.topLevelTargets(module);
	}

	/** Most-used symbols first. Hub rank, which is fan-in sorted, ties by id so two runs agree. */
	mostReferenced(limit: number): Array<{ symbolId: string; count: number }> {
		return this.searchQueries.mostReferenced(limit);
	}

	/** Git's word on a file as recorded; null on a row written without asking. */
	generatedOf(module: string): GeneratedVerdict | null {
		return this.searchQueries.generatedOf(module);
	}

	/** Every row takes the verdict admission just reached, so a file left unread keeps no stale one. */
	syncGenerated(verdicts: ReadonlyMap<string, GeneratedVerdict>): number {
		const rows = this.db.prepare("SELECT module, generated, generatedReason FROM files").all() as Array<{
			module: string;
			generated: string | null;
			generatedReason: string | null;
		}>;
		const stale = rows.flatMap((row) => {
			const verdict = verdicts.get(row.module);
			if (verdict === undefined) return [];
			const reason = verdict.status === "unknown" ? verdict.reason : null;
			return row.generated === verdict.status && row.generatedReason === reason
				? []
				: [{ module: row.module, status: verdict.status, reason }];
		});
		if (stale.length === 0) return 0;
		const update = this.db.prepare("UPDATE files SET generated = ?, generatedReason = ? WHERE module = ?");
		this.indexWrite(() => {
			for (const row of stale) update.run(row.status, row.reason, row.module);
		});
		return stale.length;
	}

	/** Symbols nothing references. Honest only as far as binding reaches, which the caller states. */
	unreferencedSymbols(): StoredDeclaration[] {
		return this.searchQueries.unreferencedSymbols();
	}

	close(): void {
		try {
			this.commitBatch();
			this.purge.settle(true);
		} finally {
			this.purge.close();
			this.db.close();
		}
	}
}
