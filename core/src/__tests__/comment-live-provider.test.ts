// Real provider output, through real attachment, to a real stored fact.
//
// The seam nothing else covers. The unit tests inject synthetic spans and the provider tests read
// their own parser, so a provider whose ranges disagreed with core's expectations would pass both
// and fail only here. Everything else about this tier was verified by hand at a terminal, which is
// exactly the kind of proof that stops happening once the person who wrote it moves on.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverProviders, lexiconRoot, startProviders } from "../providers";
import { LexiconService } from "../service";
import { IndexStore } from "../store";
import { ProviderSupervisor } from "../supervisor";

////////////////////////////////
//  Helpers

let root: string;
let store: IndexStore;
let supervisor: ProviderSupervisor;

/** Only TypeScript: this proves the seam, and every other provider would add a startup for it. */
const TYPESCRIPT_ONLY = discoverProviders(lexiconRoot()).filter((command) => command.directory === "typescript");

const SOURCE = [
	"// A run of two lines,",
	"// wrapped mid-sentence.",
	"export function work(): number {",
	"\t// why this order",
	"\treturn 1;",
	"}",
	"",
	"// Not attached to anything below.",
	"",
	"export const total = 42;",
	"",
].join("\n");

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-live-comments-"));
	store = IndexStore.open(path.join(root, "index.sqlite")).store;
	supervisor = new ProviderSupervisor();
});

afterEach(() => {
	supervisor.stopAll();
	store.close();
	rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("a real provider's comments, attached by core", () => {
	it.skipIf(TYPESCRIPT_ONLY.length === 0)(
		"groups, attaches and stores what the provider actually emitted",
		async () => {
			mkdirSync(path.join(root, "src"), { recursive: true });
			writeFileSync(path.join(root, "src", "work.ts"), SOURCE);
			// File discovery is git-scoped, so an unversioned directory indexes nothing at all.
			execFileSync("git", ["init", "-q"], { cwd: root });
			execFileSync("git", ["add", "-A"], { cwd: root });

			await startProviders(supervisor, root, TYPESCRIPT_ONLY);
			const service = new LexiconService(
				store,
				supervisor,
				(module) => {
					try {
						return readFileSync(path.join(root, module), "utf8");
					} catch {
						return null;
					}
				},
				root,
			);
			await service.indexWorkspace();

			const work = service.findByName("work")[0];
			expect(work).toBeDefined();

			// The wrapped run is ONE fact whose text spans the break, which is the whole point of
			// grouping and the thing a per-line implementation passes every unit test while failing.
			const documentation = service.describe(work?.symbolId ?? "")?.symbol.docComment;
			expect(documentation).toBe("A run of two lines, wrapped mid-sentence.");

			// A body comment is a note about the function, never its documentation.
			expect(service.describe(work?.symbolId ?? "")?.comments?.map((item) => item.text)).toEqual([
				"why this order",
			]);

			// Searchable by a phrase the raw text never spells contiguously.
			expect(service.findComments({ text: "lines, wrapped" }).total).toBe(1);

			// Fenced by blank lines, so it names neither neighbour.
			const floating = service.findComments({ text: "Not attached" }).comments[0];
			expect(floating?.form).toBe("standalone");
			expect(floating?.anchor).toBeNull();
		},
		60_000,
	);
});
