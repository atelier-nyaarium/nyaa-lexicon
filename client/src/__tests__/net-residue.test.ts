import { describe, expect, it } from "bun:test";
import { join, relative } from "node:path";
import { sourceFiles } from "@nyaa-lexicon/protocol";
import { parsedFiles, stringsIn } from "@nyaa-lexicon/protocol/ast";

////////////////////////////////
//  Interfaces & Types

/**
 * Holds the daemon wire to exactly two socket owners: the client's end and the daemon's end.
 *
 * Bug class killed: a third module opening a socket of its own, with its own framing, its own
 * heartbeat answer and its own idea of what a closed connection means. Presence is counted on
 * the daemon's end from what the client's end does; a third end is invisible to both.
 */
const ROOT = join(import.meta.dirname, "..", "..", "..");

const SWEPT = [join(ROOT, "client", "src"), join(ROOT, "core", "src"), join(ROOT, "adapters")];

/** The two ends, as paths from the repository root. */
const OWNERS = ["client/src/transport.ts", "core/src/socketTransport.ts"];

/** Other importers, and why none is a wire. */
const EXEMPT = new Map([["client/src/identity.ts", "holds a Windows pipe as a process mark; no frame crosses it"]]);

/** The module specifier, as any string in code: an import, a `require` or a dynamic import. */
const SPECIFIER = "node:net";

const SKIP = ["__tests__", "dist", "node_modules", ".tsbuild"];

////////////////////////////////
//  Tests

describe("two modules own the daemon wire", () => {
	it("finds source files in every swept tree, so a passing run is never vacuous", () => {
		for (const dir of SWEPT) expect(sourceFiles(dir, SKIP).length, dir).toBeGreaterThan(0);
	});

	it("has node:net imported by the client's transport and the daemon's, and nothing else", () => {
		const importers = SWEPT.flatMap((dir) => parsedFiles(dir, SKIP))
			.filter(({ source }) => stringsIn(source).some(({ text }) => text === SPECIFIER))
			.map(({ file }) => relative(ROOT, file).split("\\").join("/"))
			.filter((file) => !EXEMPT.has(file))
			.sort();

		expect(
			importers,
			"a socket to the daemon is opened in client/src/transport.ts and answered in core/src/socketTransport.ts. Speak frames through them rather than opening a third.",
		).toEqual(OWNERS);
	});
});
