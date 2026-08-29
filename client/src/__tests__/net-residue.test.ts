import { describe, expect, it } from "bun:test";
import { join, relative } from "node:path";
import { codeOnly, readSwept, sourceFiles } from "@nyaa-lexicon/protocol";

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

/** The narrowest unambiguous token: the module specifier itself, quotes included. */
const TOKEN = '"node:net"';

const SKIP = ["__tests__", "dist", "node_modules", ".tsbuild"];

////////////////////////////////
//  Tests

describe("two modules own the daemon wire", () => {
	it("finds source files in every swept tree, so a passing run is never vacuous", () => {
		for (const dir of SWEPT) expect(sourceFiles(dir, SKIP).length, dir).toBeGreaterThan(0);
	});

	it("has node:net imported by the client's transport and the daemon's, and nothing else", () => {
		const importers = SWEPT.flatMap((dir) => sourceFiles(dir, SKIP))
			.filter((file) => {
				const source = readSwept(file);
				return source !== null && codeOnly(source).includes(TOKEN);
			})
			.map((file) => relative(ROOT, file).split("\\").join("/"))
			.sort();

		expect(
			importers,
			"a socket to the daemon is opened in client/src/transport.ts and answered in core/src/socketTransport.ts. Speak frames through them rather than opening a third.",
		).toEqual(OWNERS);
	});
});
