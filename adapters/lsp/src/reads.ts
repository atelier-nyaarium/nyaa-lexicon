// What the editor adapter needs from an index, and the two places it can come from.
//
// The point of the interface is that the editor stops being special. Before this, the LSP adapter
// took a concrete LexiconService and built its own in-memory index, so an editor sitting open all
// day shared nothing with the agents working in the same repository and did not even count as a
// connected client for the daemon's shutdown timer. The daemon exists to prevent exactly that.
//
// Every method is a Promise, including the six that used to be synchronous store reads, because
// over a socket they are. That is the honest shape: a caller cannot tell from the signature whether
// the answer crossed a process boundary, and it should not be able to.

import type {
	CallHierarchy,
	DaemonChannel,
	DescribeResult,
	LexiconService,
	RecalledAnswer,
	ReferencesResult,
	RenameEditPlan,
	RenamePlan,
	StoredDeclaration,
	TypeHierarchy,
	TypeInfo,
} from "@nyaa-lexicon/core";

////////////////////////////////
//  Interfaces & Types

/**
 * The read surface an editor needs. Deliberately no writes at all.
 *
 * A rename is the one editor request that changes files, and LSP has the EDITOR apply it: the
 * server returns a WorkspaceEdit and the editor writes. So even rename is a read here, and nothing
 * on this interface ever touches disk.
 *
 * `transactionOpen` is the exception that proves it. An open refactor transaction holds journaled
 * images of the files it has touched, and an undo restores them. A rename lexicon itself hands the
 * editor mid-transaction would be written outside that journal and silently reverted by it, so the
 * one thing rename must ask before offering edits is whether a transaction is open.
 */
export interface LexiconReads {
	declarationsIn(module: string): Promise<StoredDeclaration[]>;
	declarationOf(symbolId: string): Promise<StoredDeclaration | null>;
	describe(symbolId: string): Promise<DescribeResult | null>;
	findReferences(symbolId: string, limit?: number): Promise<ReferencesResult>;
	typeOf(symbolId: string): Promise<TypeInfo>;
	typeHierarchy(symbolId: string): Promise<TypeHierarchy>;
	callHierarchy(symbolId: string): Promise<CallHierarchy>;
	recallAnswers(symbolId: string): Promise<RecalledAnswer[]>;
	prepareRename(symbolId: string, newName: string): Promise<RenamePlan>;
	renameEdits(symbolId: string, newName: string): Promise<RenameEditPlan>;
	transactionOpen(): Promise<boolean>;
}

////////////////////////////////
//  Functions & Helpers

/**
 * Reads answered by the workspace's daemon, over the shared channel.
 *
 * The open connection is what tells the daemon this editor exists, which is half the reason to
 * prefer it: the other half is that the editor and every agent then read one index rather than two
 * that can disagree.
 */
export function daemonReads(channel: DaemonChannel): LexiconReads {
	return {
		declarationsIn: (module) => channel.ask("declarationsIn", { module }),
		declarationOf: (symbolId) => channel.ask("declarationOf", { symbolId }),
		describe: (symbolId) => channel.ask("describe", { symbolId }),
		findReferences: (symbolId, limit) => channel.ask("findReferences", { symbolId, limit }),
		typeOf: (symbolId) => channel.ask("typeOf", { symbolId }),
		typeHierarchy: (symbolId) => channel.ask("typeHierarchy", { symbolId }),
		callHierarchy: (symbolId) => channel.ask("callHierarchy", { symbolId }),
		// The daemon serves both arities of recall on one method; no question means all of them.
		recallAnswers: (symbolId) => channel.ask("recallAnswer", { symbolId }),
		prepareRename: (symbolId, newName) => channel.ask("prepareRename", { symbolId, newName }),
		renameEdits: (symbolId, newName) => channel.ask("renameEdits", { symbolId, newName }),
		transactionOpen: async () => (await channel.ask<{ open: boolean }>("refactorStatus", {})).open,
	};
}

/**
 * Reads from a source that is not chosen yet, resolved once on the first question.
 *
 * An editor's `initialize` must be answered at once, and deciding between the daemon and a local
 * index means possibly spawning a process and waiting for its lock. So the decision is deferred to
 * the first request that actually needs an answer, and made only once however many arrive together.
 */
export function deferredReads(resolve: () => Promise<LexiconReads>): LexiconReads {
	let ready: Promise<LexiconReads> | null = null;
	const reads = (): Promise<LexiconReads> => (ready ??= resolve());

	return {
		declarationsIn: async (module) => (await reads()).declarationsIn(module),
		declarationOf: async (symbolId) => (await reads()).declarationOf(symbolId),
		describe: async (symbolId) => (await reads()).describe(symbolId),
		findReferences: async (symbolId, limit) => (await reads()).findReferences(symbolId, limit),
		typeOf: async (symbolId) => (await reads()).typeOf(symbolId),
		typeHierarchy: async (symbolId) => (await reads()).typeHierarchy(symbolId),
		callHierarchy: async (symbolId) => (await reads()).callHierarchy(symbolId),
		recallAnswers: async (symbolId) => (await reads()).recallAnswers(symbolId),
		prepareRename: async (symbolId, newName) => (await reads()).prepareRename(symbolId, newName),
		renameEdits: async (symbolId, newName) => (await reads()).renameEdits(symbolId, newName),
		transactionOpen: async () => (await reads()).transactionOpen(),
	};
}

/**
 * Reads answered by an index in this process, for when no daemon can be started.
 *
 * The fallback, not the design. It exists so an editor opened on a checkout with no built bundle
 * still answers questions instead of failing every request.
 */
export function localReads(service: LexiconService): LexiconReads {
	return {
		declarationsIn: async (module) => service.declarationsIn(module),
		declarationOf: async (symbolId) => service.declarationOf(symbolId),
		describe: async (symbolId) => service.describe(symbolId),
		findReferences: async (symbolId, limit) => service.findReferences(symbolId, limit),
		typeOf: (symbolId) => service.typeOf(symbolId),
		typeHierarchy: async (symbolId) => service.typeHierarchy(symbolId),
		callHierarchy: async (symbolId) => service.callHierarchy(symbolId),
		recallAnswers: async (symbolId) => service.recallAnswers(symbolId),
		prepareRename: (symbolId, newName) => service.prepareRename(symbolId, newName),
		renameEdits: (symbolId, newName) => service.renameEdits(symbolId, newName),
		// No daemon means no journal to conflict with, so nothing here can be mid-transaction.
		transactionOpen: async () => false,
	};
}
