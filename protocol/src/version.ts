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
export const PROTOCOL_VERSION = "1.0.0" as const;

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
