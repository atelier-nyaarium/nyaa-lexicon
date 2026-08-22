// Why a key is not indexed, worded once for every reader.

import type { Diagnostic } from "@nyaa-lexicon/protocol";

/**
 * A key the index cannot hold.
 *
 * `repeated` warns because the file says two things and only one is indexed. The others are `info`:
 * a key with no name and a key that is not a scalar have nothing an id could carry, so nothing is
 * lost that a different reader would have found.
 */
type DropReason = "repeated" | "nameless" | "unnameable";

const REASONS: Record<DropReason, { severity: Diagnostic["severity"]; say: (name: string) => string }> = {
	repeated: {
		severity: "warning",
		say: (name) => `a key spelled ${name} appears more than once; the last one is indexed`,
	},
	nameless: { severity: "info", say: () => "a key with no name cannot be addressed, so it is not indexed" },
	unnameable: {
		severity: "info",
		say: () => "a key that is not a scalar cannot be named, so it is not indexed",
	},
};

/** Reported, never skipped. */
export function droppedKey(reason: DropReason, module: string, range: Diagnostic["range"], name = ""): Diagnostic {
	const { severity, say } = REASONS[reason];
	return { severity, message: say(JSON.stringify(name)), path: module, ...(range === undefined ? {} : { range }) };
}
