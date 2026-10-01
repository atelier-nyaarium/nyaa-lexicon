// The daemon's method table.
//
// One place mapping a wire method to a service call, so the daemon stays transport-only and the
// service stays unaware that anything is remote.

import {
	DAEMON_METHODS,
	type DaemonMethod,
	defined,
	isDaemonMethod,
	type RequestOf,
	type ResponseOf,
} from "@nyaa-lexicon/protocol";
import { changedWhilePlanned, type Refusal, staleSincePlanned } from "./refusals.js";
import type { LexiconService } from "./service.js";
import {
	committedOutcome,
	type Gate,
	moveOutcome,
	moveStale,
	type RefactorDeps,
	refactorInsert,
	refactorMove,
	refactorRename,
	refactorReplace,
	renameStepOutcome,
	underClientStep,
} from "./stepRunners.js";
import type { TransactionManager } from "./transactions.js";
import { BUILD_VERSION } from "./version.js";
import type { WorkspaceGate } from "./workspaceGate.js";

export type { InsertOutcome, MoveOutcome, RenameStepOutcome, ReplaceOutcome } from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Interfaces & Types

type Effect = "read" | "write" | "staged" | "status";

type Run<M extends DaemonMethod> = (params: RequestOf<M>, gate: Gate) => Promise<ResponseOf<M>> | ResponseOf<M>;

declare const handlerBrand: unique symbol;

/** A handler names its effect, and only `read`, `write` and `staged` mint one: a bare function
 * cannot sit in the table, so no method runs without saying whether it writes. */
interface Handler<M extends DaemonMethod> {
	readonly effect: Effect;
	readonly run: Run<M>;
	readonly [handlerBrand]: true;
}

////////////////////////////////
//  Functions & Helpers

function mint<M extends DaemonMethod>(effect: Effect, run: Run<M>): Handler<M> {
	return { effect, run } as Handler<M>;
}

/** Runs under the shared gate: alongside other readers, never inside a write. */
const read = <M extends DaemonMethod>(run: Run<M>): Handler<M> => mint("read", run);

/** Runs alone under the exclusive gate. */
const write = <M extends DaemonMethod>(run: Run<M>): Handler<M> => mint("write", run);

/** Takes the gate itself, in parts, through the one it is handed: for work that plans outside and writes inside. */
const staged = <M extends DaemonMethod>(run: Run<M>): Handler<M> => mint("staged", run);

/**
 * Takes no gate, so a status answer never waits behind a batch or a step. Its reads are one
 * synchronous span, so they agree with each other; mid-batch they see a partial batch, as a shared
 * read already sees a partial scan.
 */
const status = <M extends DaemonMethod>(run: Run<M>): Handler<M> => mint("status", run);

/** The service's gate in the two halves a handler takes, so no caller can supply a second one. */
export function gateOf(gate: WorkspaceGate): Gate {
	return {
		read: <T>(work: () => Promise<T> | T): Promise<T> => gate.shared(async () => work()),
		write: <T>(work: () => Promise<T> | T): Promise<T> => gate.exclusive(async () => work()),
	};
}

////////////////////////////////
//  Previews

async function previewMove(
	service: LexiconService,
	args: { symbolId: string; toModule: string },
): Promise<ResponseOf<"previewMove">> {
	const refused = (reason: Refusal): ResponseOf<"previewMove"> => ({
		ok: false,
		files: [],
		issues: [],
		blockers: [{ reason }],
		reason,
	});

	const context = service.newReadContext();
	const plan = service.planMove(args.symbolId, args.toModule, context);
	if (!plan.ok) return refused(plan.reason);
	// Check stale sites before provider requests.
	const stale = service.staleModules([plan.fromModule, ...plan.referencing]);
	if (stale.length > 0) return refused(staleSincePlanned(stale, "move"));

	const result = await service.moveEdits(plan, context);
	if (!result.ok) {
		const blockers =
			result.issues.length > 0
				? result.issues.map((issue) => ({ module: issue.module, reason: issue.detail }))
				: [{ reason: result.reason }];
		return {
			ok: false,
			files: [],
			issues: result.issues,
			blockers,
			reason: result.reason,
		};
	}
	// Targets must match planned hashes.
	const changed = result.bases.find((base) => service.currentHashOf(base.module) !== base.hash);
	const moved =
		changed !== undefined ? changedWhilePlanned(changed.module, "move") : moveStale(service, plan, context);
	if (moved !== null) return refused(moved);

	return {
		ok: true,
		files: result.files.map((file) => {
			const base = result.bases.find((candidate) => candidate.module === file.module);
			if (base === undefined) throw new Error(`move preview has no base for ${file.module}`);
			return {
				module: file.module,
				contentHash: base.hash,
				created: base.hash === null,
				text: file.text,
				edits: file.edits,
			};
		}),
		issues: result.issues,
		blockers: [],
	};
}

async function previewInsert(
	service: LexiconService,
	args: { after?: string | undefined; module?: string | undefined; text: string },
): Promise<ResponseOf<"previewInsert">> {
	const plan = await service.planInsert(args);
	if (plan.state === "refused") return { state: "refused", reason: plan.reason, issues: [] };
	if (plan.state === "present") return { state: "present", module: plan.module, issues: [] };
	return {
		state: "planned",
		module: plan.module,
		contentHash: plan.baseHash,
		created: plan.created,
		text: plan.candidate,
		edits: plan.edits,
		issues: plan.issues,
	};
}

////////////////////////////////
//  Functions & Helpers

/**
 * One handler per wire method, each taking params the table has already parsed.
 *
 * Building the map calls nothing on the service, so its key set can be checked against the table
 * over a stub.
 */
export function daemonHandlers(service: LexiconService, refactor?: RefactorDeps) {
	function transactions(): TransactionManager {
		if (!refactor) throw new Error("this daemon was built without refactor support");
		return refactor.transactions;
	}

	/**
	 * Tier 1: a symbol answer full-parses its tree ahead of the background upgrade, then answers.
	 *
	 * The one spelling of the shortcut. A handler that wires the tree by hand instead of through
	 * here is the drift the tier test fails on. The upgrade takes the gate per file itself, as the
	 * background pass does, so taking it here too would deadlock against its first file.
	 */
	const treeFirst = <M extends DaemonMethod>(
		symbolOf: (params: RequestOf<M>) => string,
		answer: (params: RequestOf<M>) => Promise<ResponseOf<M>> | ResponseOf<M>,
	): Handler<M> =>
		staged(async (params, gate) => {
			await service.ensureTreeFor(symbolOf(params));
			return gate.read(() => answer(params));
		});

	/** Complete reference facts first: the upgrade holds the gate per file as the background pass
	 * does, so nothing is taken around it here; only the answer takes the gate. */
	const upgradedRead = <M extends DaemonMethod>(
		answer: (params: RequestOf<M>) => Promise<ResponseOf<M>> | ResponseOf<M>,
	): Handler<M> =>
		staged(async (params, gate) => {
			await service.upgradeRemaining();
			return gate.read(() => answer(params));
		});

	return {
		findByName: read((params) => service.findByName(params.name, params.module)),
		describe: treeFirst(
			(params) => params.symbolId,
			(params) => service.describe(params.symbolId),
		),
		// The four below exist for the editor, which asks by position rather than by name and so
		// needs the declarations of a file and the raw hierarchy rows the MCP tools render instead.
		declarationOf: read((params) => service.declarationOf(params.symbolId)),
		declarationsIn: read((params) => service.declarationsIn(params.module)),
		typeHierarchy: treeFirst(
			(params) => params.symbolId,
			(params) => service.typeHierarchy(params.symbolId),
		),
		callHierarchy: treeFirst(
			(params) => params.symbolId,
			(params) => service.callHierarchy(params.symbolId),
		),
		symbolEdges: treeFirst(
			(params) => params.symbolId,
			(params) => service.symbolEdges(params.symbolId, params.limit),
		),
		findReferences: treeFirst(
			(params) => params.symbolId,
			(params) => service.findReferences(params.symbolId, params.limit, params.within),
		),
		usesFrom: treeFirst(
			(params) => params.symbolId,
			(params) => service.usesFrom(params.symbolId, params.limit),
		),
		resolveImport: read((params) => service.resolveImport(params.fromModule, params.specifier)),
		indexStatus: status((params) => service.indexStatus(params.concerning)),
		// Trigger lifecycle starts warming before this status answer.
		indexWorkspace: status(() => service.indexStatus()),
		findLiterals: read(({ limit, exclude, ...query }) => service.findLiterals(query, limit, exclude)),
		findComments: read(({ limit, exclude, ...query }) => service.findComments(query, limit, exclude)),
		findDocs: read(({ limit, exclude, ...query }) => service.findDocs(query, limit, exclude)),
		sharedLiterals: read((params) => service.sharedLiterals(params.minimumFiles, params.limit, params.exclude)),
		cycles: read((params) => service.cycles(params.limit)),
		mostReferenced: read((params) => service.mostReferenced(params.limit)),
		hubs: read((params) => service.mostReferenced(params.limit)),
		cacheStats: status(() => service.cacheStats()),
		searchSymbols: read((params) => service.searchSymbols(params.text, params)),
		outlineModule: read((params) => service.outline(params.module)),
		fileNotes: read((params) => service.fileNotes(params.module)),
		moduleStatus: read((params) => service.moduleStatus(params.module)),
		admittedModules: read((params) => service.admittedModules(params.modules)),
		moduleDeclarations: read((params) => service.moduleDeclarations(params.module)),
		moduleFacts: read((params) => service.moduleFacts(params.module)),
		// Candidate parses read under the gate: an index parse landing between a candidate and its
		// restore would bind against the unsaved text and store it.
		parseFacts: read((params) => service.parseFacts(params.module, params.text)),
		symbolAt: read((params) => service.symbolAt(params)),
		findImports: read((params) => service.findImports(params)),
		overview: read(() => service.overview()),
		coChangedWith: read((params) => service.coChangedWith(params.module, params.limit)),
		fileHistory: read((params) => service.fileHistory(params.module)),
		commitsMentioning: read((params) => service.commitsMentioning(params.name, params.limit)),
		// Tier 1 too: its answer carries the declaring module's references and literals, which
		// outline facts genuinely lack.
		factsFor: treeFirst(
			(params) => params.symbolId,
			(params) => service.factsFor(params.symbolId, params.limit),
		),
		resolveFacts: read((params) => service.resolveFacts(params.factIds)),
		recordAnswer: write((params) =>
			service.recordAnswer(params.symbolId, params.question, params.prose, params.citations, {
				...defined({ model: params.model, resolvesDoubt: params.resolvesDoubt }),
			}),
		),
		invalidateAnswer: write((params) =>
			service.invalidateAnswer(params.symbolId, params.reason, params.question, params.by),
		),
		reaffirmAnswer: write((params) =>
			service.reaffirmAnswer(params.symbolId, params.question, {
				...defined({ citations: params.citations, model: params.model, resolvesDoubt: params.resolvesDoubt }),
			}),
		),
		// The survey counts nothing. One question's recall is a read, and the demand it found is
		// counted afterwards as its own write, so the count never rides inside a shared hold.
		recallAnswer: staged(async (params, gate) => {
			const { symbolId, question } = params;
			if (question === undefined) return gate.read(() => service.recallAnswers(symbolId));
			const recalled = await gate.read(() => service.recallAnswer(symbolId, question));
			const demand = service.demandOf(symbolId, question, recalled);
			if (demand !== null) await gate.write(() => service.recordDemand(demand));
			return recalled;
		}),
		knowledgeGaps: read((params) =>
			service.knowledgeGaps(params.root, params.question, params.limit, params.module),
		),
		knowledgeScope: read((params) => service.knowledgeScope(params)),
		readNote: read((params) => service.readNote(params.symbolId)),
		writeNote: write((params) => service.writeNote(params)),
		confirmNote: write((params) => service.confirmNote(params.symbolId, params.expectedRevision, params.author)),
		doubtNote: write((params) =>
			service.doubtNote(params.symbolId, params.reason, params.expectedRevision, params.author),
		),
		resolveNoteProposal: write((params) =>
			service.resolveNoteProposal(
				params.symbolId,
				params.accept,
				params.expectedRevision,
				params.expectedProposal,
				params.author,
			),
		),
		noteBacklinks: read((params) => service.noteBacklinks(params.symbolId, params.limit)),
		searchRefs: read((params) => service.searchRefs(params.text, params.limit, params.kinds)),
		diagnoseSubject: read((params) => service.diagnoseSubject(params.symbolId)),
		typeOf: treeFirst(
			(params) => params.symbolId,
			(params) => service.typeOf(params.symbolId),
		),
		// Read-only, and kept because the editor asks it to decide whether to offer a rename.
		prepareRename: upgradedRead((params) =>
			service.prepareRename(params.symbolId, params.newName, service.newReadContext()),
		),
		// The edits a rename would make, for a caller that applies them itself.
		renameEdits: upgradedRead((params) => service.renameEdits(params.symbolId, params.newName)),
		planMove: upgradedRead((params) =>
			service.planMove(params.symbolId, params.toModule, service.newReadContext()),
		),
		// Upgrade outlines before preview reads.
		previewMove: upgradedRead((params) => previewMove(service, params)),
		previewInsert: upgradedRead((params) => previewInsert(service, params)),
		indexFile: write((params) => service.indexFile(params.module)),
		symbolSource: read((params) => service.symbolSource(params)),
		refactorStart: write(() => transactions().start()),
		// A step mid-write can read as drift here; revert and commit check again under the gate.
		refactorStatus: status(() => transactions().status()),
		refactorTrack: write((params) => transactions().track(params.module)),
		refactorNoteWrite: write((params) =>
			transactions().noteWrite(
				params.module,
				"absent" in params ? { absent: true } : { contentHash: params.contentHash },
			),
		),
		refactorBeforeImage: read((params) =>
			transactions().beforeImage(params.module, params.id, params.content !== false),
		),
		refactorSettlements: status((params) => transactions().settlements(params.after, params.limit)),
		refactorSettledImage: read((params) => transactions().settledImage(params.seq, params.module, params.side)),
		refactorWriteFile: write(async ({ module, content, expect, refactor }) => {
			const bytes =
				content === null
					? null
					: content.encoding === "text"
						? { text: content.text }
						: { bytes: Buffer.from(content.bytes, "base64") };
			const outcome = transactions().writeFile(module, bytes, expect, refactor);
			if (!outcome.written) return outcome;
			const indexed = await service.indexFile(module).then(
				() => true,
				() => false,
			);
			return { ...outcome, indexed };
		}),
		// Restoring puts back text the index does not describe, so the facts for those files are
		// of a version that no longer exists on disk.
		refactorUndo: write(async (params) => {
			const outcome = transactions().undo(params.expect);
			for (const module of outcome.modules ?? []) await service.indexFile(module);
			return outcome;
		}),
		refactorRevert: write(async (params) => {
			const outcome = transactions().revert(params.drifted, params.expect);
			for (const module of outcome.modules) await service.indexFile(module);
			return outcome;
		}),
		refactorCommit: write((params) => transactions().commit(params)),
		refactorReplace: staged((params, gate) => refactorReplace(service, transactions(), gate.write, params)),
		refactorReplaceSpan: staged((params, gate) =>
			refactorReplace(service, transactions(), gate.write, params, {
				expectedSpanHash: params.expectedSpanHash,
				hold: params.standalone === true ? "joinOrOwn" : "join",
			}),
		),
		refactorInsert: staged((params, gate) => refactorInsert(service, transactions(), gate.write, params)),
		refactorRename: staged((params, gate) =>
			refactorRename(service, transactions(), gate.write, params, "join").then(renameStepOutcome),
		),
		refactorMove: staged((params, gate) =>
			refactorMove(service, transactions(), gate.write, params, "join").then(moveOutcome),
		),
		refactorRenameCommitted: staged((params, gate) =>
			underClientStep(transactions(), params.stepId, "rename", (cancelled) =>
				refactorRename(service, transactions(), gate.write, params, { own: params.bases }, cancelled).then(
					committedOutcome("rename"),
				),
			),
		),
		refactorMoveCommitted: staged((params, gate) =>
			underClientStep(transactions(), params.stepId, "move", (cancelled) =>
				refactorMove(service, transactions(), gate.write, params, { own: params.bases }, cancelled).then(
					committedOutcome("move"),
				),
			),
		),
		// Neither waits on the gate: a step holding it is past cancelling, and its outcome is a row.
		refactorStepOutcome: staged((params) => transactions().stepOutcome(params.stepId)),
		refactorStepCancel: staged((params) => transactions().cancelStep(params.stepId)),
	} satisfies { [M in DaemonMethod]: Handler<M> };
}

/** Includes this build to diagnose client and daemon table mismatches. */
export function unknownMethod(method: string): Error {
	return new Error(`unknown method: ${method} (this daemon runs ${BUILD_VERSION})`);
}

/**
 * Dispatch one call: parse the request through the table, run its handler, parse the answer.
 *
 * An unknown method throws rather than answering null, so a client built against a newer daemon
 * learns the method is missing instead of reading an empty answer as a real one.
 */
export function createDispatch(service: LexiconService, refactor?: RefactorDeps) {
	const handlers = daemonHandlers(service, refactor);
	const gate = gateOf(service.gate);
	return async (method: string, params: unknown): Promise<unknown> => {
		if (!isDaemonMethod(method)) throw unknownMethod(method);
		let args: unknown;
		try {
			args = DAEMON_METHODS[method].request.parse(params ?? {});
		} catch (error) {
			// Lexicon's own words, never a zod blob: the field, then what the schema said about it.
			const issues =
				(error as { issues?: Array<{ path: Array<string | number>; message: string }> }).issues ?? [];
			const worded = issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`);
			throw new Error(`${method} refused: ${worded.length === 0 ? String(error) : worded.join("; ")}`);
		}
		// Looked up by a runtime key, the handler's parameter is the intersection of every request.
		const handler: { effect: Effect; run: (params: never, gate: Gate) => unknown } = handlers[method];
		const run = () => handler.run(args as never, gate);
		const answer =
			handler.effect === "read"
				? await gate.read(run)
				: handler.effect === "write"
					? await gate.write(run)
					: await run();
		return DAEMON_METHODS[method].response.parse(answer);
	};
}
