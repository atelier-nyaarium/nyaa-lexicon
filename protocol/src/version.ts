// Protocol version negotiation. Core and providers ship separately, so both sides meet a peer
// that is not their own build.

import { safeDigits } from "./cursor.js";

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
export const PROTOCOL_VERSION = "3.15.0" as const;

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
