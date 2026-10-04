// Protocol version negotiation. Core and providers ship separately, so both sides meet a peer
// that is not their own build.

import { safeDigits } from "./parseResult.js";

////////////////////////////////
//  Interfaces & Types

export interface Version {
	major: number;
	minor: number;
	patch: number;
}

export type Compatibility =
	| { ok: true; note?: string }
	| { ok: false; reason: "malformed" | "majorMismatch"; detail: string };

////////////////////////////////
//  Constants

// 1.0.0: the daemon-client wire moved from one-shot HTTP to framed sockets, the first breaking
// change; the major bump is what makes a client meeting a leftover HTTP daemon replace it rather
// than hang on a handshake the old server cannot speak.
// 1.1.0: imports may expose an indexable surface and parseFile may request surface depth.
// Outline requests and extraction-depth metadata are part of the 1.2 wire contract.
// 2.0.0: comment spans are emitted and docComment is retired, so a declaration no longer carries
// its own prose; the major is the removal, not the addition.
// 3.0.0: every path-valued request field is normalized and contained, `moduleDeclarations` binds an
// answer to its bytes, and `IndexOutcome` carries a closed cause. A clean break, no window.
// 3.1.0: `shebangs` claims an extensionless file by the interpreter its first line names.
// 3.2.0: `refactorReplaceSpan` and `symbolSource.spanHash`. A method, not a field, since an older
// daemon strips an unknown field and would skip the check.
// 3.3.0: `usesFrom` and `knowledgeScope`, and read-time fields on reference rows and the graph.
// A gap row gains `shaky`, beside a `why` of `stale` an older client still reads.
// The `forgetModule` provider notification, which an older provider ignores.
// `describe.members` no longer lists parameters and locals. `referenceCount`, `findReferences`,
// `mostReferenced`, `graph.fanIn`, `graph.fanOut`, `graph.cycle` and gap `fanIn` no longer count
// import and export lines. `Declaration.contains`, an older core ignores.
// 3.4.0: `DaemonLockSchema` gains an optional `role`, `"daemon"` or `"delete"`, naming which side
// of a store's lock a claim represents. Absent reads as `"daemon"`, an older lock's only meaning.
// 3.5.0: `moduleFacts` and `parseFacts`, two reads that answer a module's declarations, references,
// literals, comments and language words as paint facts, for a client that colors code itself.
// 3.6.0: an error response may carry `code`, closed to `"stopping"`, so a client retiring a daemon
// reads why it refused structurally rather than matching its prose.
// 3.7.0: `describe.questions`, the knowledge questions the symbol's kind takes, computed by the core.
// 3.8.0: `passive` methods (`indexStatus`, `refactorStatus`) neither start indexing nor wait on it;
// a failed warmup still refuses `indexStatus`. Unknown methods no longer start indexing.
// 3.9.0: every method declares a `lifecycle` (query, status, probe, trigger) and `mutates`;
// `shutdown` is a control. `indexWorkspace` starts indexing and answers at once. An unknown name is
// refused before the handler lands too. An error's `code` is read as any string, so a newer
// daemon's code never drops an older client's connection.
// 3.10.0: `symbolAt`, the symbol a cursor means in stored or handed text. `indexStatus.generation`,
// which changes whenever stored facts do. `callHierarchy.incomingFromModules`, top-level callers.
// 3.11.0: `parseFile.probe`, a parse the core never rules on, so no admission is staged; an older
// provider stages it anyway. Stored `symbolAt` answers `unowned` for a module no provider claims.
// 3.12.0: `probeFile` replaces `parseFile.probe`: one request, and the provider puts back what the
// parse displaced. `symbolAt` takes `contentHash` and answers `needsText` when neither the stored
// facts nor a kept candidate hold those bytes.
// 3.13.0: the `fileRoles` tier and `FileFacts.role`, which an older core ignores. `describe.moduleRole`
// and `overview.entryPoints`. `indexStatus.generation` also moves on knowledge writes.
// 3.14.0: a `main` file role requires the symbol id of its declaration.
// 3.15.0 defines previews, before-images and transaction expectations.
// 3.16.0: `refactorStatus` reports drifted module hashes, `refactorNoteWrite` records an editor
// write, and `refactorRevert` confirms those hashes before restoring. Recovery retains each
// pre-revert disk state, and known-state edits advance the transaction revision.
// 3.17.0: `refactorRenameCommitted` and `refactorMoveCommitted` write a step as its own committed
// refactor, refuse one open, check `bases` against the before-images, and answer the reverse step.
// Methods, not a flag, since an older daemon strips a field and would join. `refactorTrack.refactor`.
// Six value searches take `exclude` and echo `excluded: true`; a client refuses an answer without it.
// `admittedModules` says whether discovery or an import admits each module.
// A module whose real path leaves the workspace is unclaimed and forgotten, and writes refuse it.
// A signature is the whole header on one line, through `renderHeader`. `outlineModule` leaves locals
// out and each row carries `referenceCount`.
// 3.18.0: a settlement ledger written at every refactor close (`refactorSettlements`,
// `refactorSettledImage`, `ledger` on status and track) and `refactorWriteFile`, a gated write.
// 3.19.0: `refactorWriteFile.refactor` refuses a write unless that refactor, or none, is open.
// `refactorBeforeImage.content: false` omits the bytes. An older daemon drops either field.
// `Reference.qualified` marks a use reached through a receiver or path; an older core ignores it.
// 3.20.0: `oldestClientMajor` on the lock, the welcome and `version.json`: the oldest protocol major
// whose table the daemon still serves. A client behind a newer major rides only down to it; absent
// reads as the daemon's own major. A committed step takes a client's `stepId`, and
// `refactorStepOutcome` and `refactorStepCancel` answer what became of it. An older daemon strips the id.
// Provider `initialize` carries the scope's `deny` globs, which the provider never reads.
// The `releaseModule` provider notification, which an older provider ignores.
// A blocked move site may answer `TargetCollision`. `ImportedName.kind` states the form that binds
// a name, so a default import no longer reads as a namespace one; an older core ignores it.
// `typeOnly` is a flag on imported names, origins and sites, composing with any form; the
// `typeOnly` import kind is gone, and `require` names an import-equals. `ProjectModel.fingerprint`:
// when it moves, core parses every module the provider owns again.
// 3.21.0: `bundleWrittenAt` on the lock, when the daemon's bundle was last written. Of two bundles
// of one build, a client replaces only a daemon whose bundle was written before its own; an older
// daemon omits it and is replaced on a stamp mismatch alone. The `providerPhase` notification, sent
// by a provider unasked, which an older core ignores. `indexStatus.providers` and
// `indexStatus.activity`, which an older daemon omits.
// 3.22.0: knowledge notes. `readNote`, `writeNote`, `confirmNote`, `doubtNote`,
// `resolveNoteProposal`, `noteBacklinks` and `searchRefs`; an older daemon answers them as unknown
// methods.
// `recordAnswer` takes no `omitting`, and its refusal carries no `uncovered`.
// 3.23.0: `resolveNoteProposal` takes `expectedProposal`, the shown proposal's `at`, which rises
// per proposal on a note; a replaced proposal refuses. An older daemon ignores it.
// 3.24.0: `symbolEdges`, both directions by role, each site credited to the declaration owning it; an
// older daemon answers it as an unknown method. `callHierarchy` credits a call written in a local to
// the local's owner, in both directions.
// 4.0.0: a note is one markdown `text` opening with its summary paragraph, in place of `summary`,
// `description`, `why` and `gotchas`; empty text removes it. `writeNote` takes `text`. Links and
// backlinks lose `field`; a ref problem carries `at`. A clean break, no window.
// 4.1.0: a move insertion's `exported` asks the target to export what it inserts; an older provider
// ignores it. `MovePlan.exportsAtTarget`, which an older daemon omits. The `BrokenImport` reason: a
// local import binding nothing.
// 4.2.0: `searchRefs` takes `kinds`; an older daemon ignores them and answers every kind. The
// `FixFailed` issue: `lexicon.json`'s `fix` ran on a step's files and did not exit cleanly.
// `refactorMove` takes `together`, more declarations moving with it, one step each, each after the
// ones it uses; `MoveOutcome.order` names them. An older daemon ignores `together` and moves one.
// 4.3.0: `previewMove`, `planMove` and `refactorMove` take `anchor`, a top-level declaration in the
// target the move lands before or after (for a reorder, a sibling); with it the target may be the
// source, which reorders. An older daemon ignores it: a move to another module lands at the end, and
// a reorder refuses.
// 4.4.0: `previewArrange` and `refactorArrange` place declarations from one module, or the target's
// own, in the target as one step, through the provider method `arrangeEdits`. An older daemon
// answers them as unknown methods; an older provider does not answer it, so the request fails.
// 5.0.0: a clean break for rename routes. `resolveImport` answers a tagged `landing` (a module, a
// symbol scope or a package scope) in place of `module`. An import is one edge per transfer, `edges`
// in place of `imported` and `reExport`, each with its selector, conflict policy, meaning, certainty
// and order. `FileFacts` gains `exports`, `allList` and `scopeContributions`; a reference may carry
// its proved `origin`. The provider method `probeBatch`; the tiers `exports` and `renameKeep`;
// `RenameSite.keep`. Rename requests take `stops`; the plan answers `routes` and `mentions`. The
// `export` fact kind, and the issues `RouteUnknown`, `RouteChanged`, `StopNotReExport`,
// `StopUnsupported` and `ProofUnavailable`. `MoveImportSite` drops `reExport`. No 4.x client is served.
// 6.0.0: answers are retired. `factsFor`, `resolveFacts`, `recordAnswer`, `invalidateAnswer`,
// `reaffirmAnswer`, `recallAnswer` and `knowledgeGaps` are gone, with the `answer` and `doubt` fact
// kinds, `describe.questions`, `overview.knowledge` and every `migrated` count. `knowledgeScope` is
// `scopeSymbols`, without `questions`. `searchSymbols`, `findLiterals` and `findReferences` take
// `module`, a file or a folder; `searchSymbols` takes `kind`, `module` or `within` alone, and a
// literal search takes at most one of `value`, `regex` or a range. `previewArrange` answers `placed`,
// every top-level declaration's span in the target. `SymbolSummary.lines.name`. `Literal.dedented`.
// No 5.x client is served.
// 6.1.0: a paint reference carries `name` and `target`, its identifier and its bound target or null,
// so two parses of one module compare by name; an older daemon omits both. A request frame's
// `gateWaitMs` bounds a read's wait for the workspace gate; past it the read never runs and answers
// `code: "busy"`. An older daemon strips the field and queues; an older client reads `busy` as an
// ordinary refusal.
// 6.2.0: an unbound paint reference carries `reason`, why it did not bind, so a client tells an
// external name from one that resolves to nothing; an older daemon omits it.
export const PROTOCOL_VERSION = "6.2.0" as const;

/** The oldest protocol major whose method table this build's daemon still answers in full. */
export const OLDEST_CLIENT_MAJOR = 6;

/** Store layout version; each names its own index file. */
export const SCHEMA_VERSION = 27;

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

////////////////////////////////
//  Functions & Helpers

export function parseVersion(text: string): Version | null {
	const m = SEMVER_RE.exec(text);
	if (!m) return null;

	const parts: number[] = [];
	for (const digits of m.slice(1, 4)) {
		const value = safeDigits(digits as string);
		if (value === null) return null;
		parts.push(value);
	}

	const [major, minor, patch] = parts as [number, number, number];
	return { major, minor, patch };
}

/**
 * Whether this build can speak to a peer announcing `theirs`.
 *
 * Additive-only within a major, so an older peer is compatible: it simply never sends the newer
 * optional fields. A newer minor is compatible for the same reason, and carries a note rather than
 * a refusal, since refusing would make every provider update a breaking one.
 */
export function checkCompatibility(theirs: string, ours: string = PROTOCOL_VERSION): Compatibility {
	const them = parseVersion(theirs);
	const us = parseVersion(ours);
	if (!them) return { ok: false, reason: "malformed", detail: `${JSON.stringify(theirs)} is not major.minor.patch` };
	if (!us) return { ok: false, reason: "malformed", detail: `our own version ${ours} is malformed` };

	if (them.major !== us.major) {
		return { ok: false, reason: "majorMismatch", detail: `peer speaks ${theirs}, we speak ${ours}` };
	}
	if (them.minor > us.minor)
		return { ok: true, note: `peer is newer (${theirs} vs ${ours}); unknown fields ignored` };
	if (them.minor < us.minor) return { ok: true, note: `peer is older (${theirs} vs ${ours}); newer fields absent` };
	return { ok: true };
}

/** Convenience for a gate that only needs a yes or no. */
export function isCompatibleProtocol(theirs: string, ours: string = PROTOCOL_VERSION): boolean {
	return checkCompatibility(theirs, ours).ok;
}

/**
 * Whether a daemon on `theirs`, answering majors back to `oldestClientMajor`, serves a client on
 * `ours`. Behind the client's major it never does; ahead, only down to the major it names, which
 * absent is its own. Unparseable answers false.
 */
export function servesClient(theirs: string, oldestClientMajor: number | undefined, ours: string = PROTOCOL_VERSION) {
	const them = parseVersion(theirs);
	const us = parseVersion(ours);
	if (them === null || us === null || them.major < us.major) return false;
	return (oldestClientMajor ?? them.major) <= us.major;
}
