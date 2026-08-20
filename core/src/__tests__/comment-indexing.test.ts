// Comments end to end: a provider's spans, through the indexer, to an anchored searchable fact.
//
// The unit tests cover grouping, attachment and normalization separately. This covers the seam,
// which is where the source text has to reach the resolver, and where a wrong argument order would
// still typecheck.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommentSpan, Declaration } from "@nyaa-lexicon/protocol";
import { composeSymbolId } from "@nyaa-lexicon/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProviderClaims, Route } from "../routing";
import { LexiconService } from "../service";
import { IndexStore } from "../store";
import type { ProviderSupervisor } from "../supervisor";

////////////////////////////////
//  Helpers

let root: string;
let store: IndexStore;

const claims: ProviderClaims = { providerId: "fake", language: "fake", extensions: [".fake"] };

interface Fixture {
	text: string;
	declarations: Declaration[];
	comments: CommentSpan[];
}

function idOf(name: string): string {
	return composeSymbolId({ language: "fake", module: "a.fake", descriptors: [{ kind: "term", name }] });
}

/** A declaration spanning whole lines, which is the shape every provider's range reduces to here. */
function decl(name: string, startLine: number, endLine: number, nameChar = 0): Declaration {
	return {
		symbolId: idOf(name),
		kind: "function",
		name,
		range: { start: { line: startLine, character: 0 }, end: { line: endLine, character: 1 } },
		selectionRange: {
			start: { line: startLine, character: nameChar },
			end: { line: startLine, character: nameChar + name.length },
		},
		visibility: "public",
		exported: true,
	};
}

/** A span over one line, from `character` to the end of that line. */
function span(text: string, line: number, character: number): CommentSpan {
	const lineText = text.split("\n")[line] ?? "";
	return {
		range: { start: { line, character }, end: { line, character: lineText.length } },
		text: lineText.slice(character),
	};
}

function supervisorFor(fixture: Fixture): ProviderSupervisor {
	return {
		running: () => [claims],
		route: (module: string): Route =>
			module.endsWith(".fake")
				? { owned: true, providerId: claims.providerId }
				: { owned: false, reason: "unclaimed" },
		askProvider: async () => ({ files: ["a.fake"], externalRoots: [], configFiles: [], diagnostics: [] }),
		ask: async (_module: string, method: string, params: unknown) => {
			if (method !== "parseFile") throw new Error(`unexpected method ${method}`);
			const request = params as { module: string; contentHash: string };
			return {
				module: request.module,
				contentHash: request.contentHash,
				declarations: fixture.declarations,
				references: [],
				imports: [],
				literals: [],
				comments: fixture.comments,
				diagnostics: [],
			};
		},
		stopAll: () => {},
	} as unknown as ProviderSupervisor;
}

async function index(fixture: Fixture): Promise<LexiconService> {
	const full = path.join(root, "a.fake");
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, fixture.text);
	const service = new LexiconService(
		store,
		supervisorFor(fixture),
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
	return service;
}

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-comment-index-"));
	store = IndexStore.open(path.join(root, "index.sqlite")).store;
});

afterEach(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("indexing comments", () => {
	it("groups a wrapped run, attaches it, and makes the joined phrase searchable", async () => {
		const text = "// refuses rather than\n// clamping the value\nwork\n";
		const service = await index({
			text,
			declarations: [decl("work", 2, 2)],
			comments: [span(text, 0, 0), span(text, 1, 0)],
		});

		const attached = service.commentsFor(idOf("work"));
		expect(attached).toHaveLength(1);
		expect(attached[0]?.form).toBe("leading");
		// The phrase spans the wrap, so raw never spells it and normalized does.
		expect(attached[0]?.raw).toContain("\n");
		expect(store.commentsContaining("than clamping", 10)).toHaveLength(1);
	});

	it("derives a symbol's documentation from the comment above it", async () => {
		const text = "// what work does\nwork\n";
		const service = await index({ text, declarations: [decl("work", 1, 1)], comments: [span(text, 0, 0)] });

		expect(service.describe(idOf("work"))?.symbol.docComment).toBe("what work does");
	});

	// The other range convention, where a declaration's own range already covers its doc.
	it("attaches when the declaration's range already covers the comment", async () => {
		const text = "// what work does\nwork\n";
		const covering = decl("work", 1, 1);
		covering.range = { start: { line: 0, character: 0 }, end: { line: 1, character: 4 } };
		const service = await index({ text, declarations: [covering], comments: [span(text, 0, 0)] });

		expect(service.commentsFor(idOf("work"))[0]?.form).toBe("leading");
	});

	// A decorator sits between the prose and the name, and the range starts at the decorator.
	it("reaches past a decorator when the declaration's range starts at it", async () => {
		const text = "// what work does\n@decorated\nwork\n";
		const decorated = decl("work", 2, 2);
		decorated.range = { start: { line: 1, character: 0 }, end: { line: 2, character: 4 } };
		const service = await index({ text, declarations: [decorated], comments: [span(text, 0, 0)] });

		expect(service.commentsFor(idOf("work"))[0]?.form).toBe("leading");
	});

	it("keeps a CRLF file's comment attached and its text clean", async () => {
		const text = "// what work does\r\nwork\r\n";
		const line = "// what work does";
		const service = await index({
			text,
			declarations: [decl("work", 1, 1)],
			comments: [
				{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: line.length } }, text: line },
			],
		});

		const [found] = service.commentsFor(idOf("work"));
		expect(found?.form).toBe("leading");
		expect(found?.normalized).toBe("what work does");
	});

	it("calls a block comment opened after code on its line trailing, not leading", async () => {
		const text = "work /* about work\n   continued */\nother\n";
		const block = {
			range: { start: { line: 0, character: 5 }, end: { line: 1, character: 15 } },
			text: "/* about work\n   continued */",
		};
		const service = await index({
			text,
			declarations: [decl("work", 0, 0), decl("other", 2, 2)],
			comments: [block],
		});

		const [found] = service.commentsFor(idOf("work"));
		expect(found?.form).toBe("trailing");
		expect(found?.placement).toBe("after");
		// And it must NOT have been read as documentation for the declaration below it.
		expect(service.commentsFor(idOf("other"))).toEqual([]);
	});

	// The indentation-scoped case, where no closing brace separates a body's last comment from the
	// next declaration. It belongs to the body it is indented into, not to what follows.
	it("anchors a tail comment to the scope holding it, not the declaration below", async () => {
		const text = "def work():\n\treturn 1\n\t# why this order\ndef other():\n\tpass\n";
		const enclosing = decl("work", 0, 2);
		enclosing.range = { start: { line: 0, character: 0 }, end: { line: 2, character: 17 } };
		const service = await index({
			text,
			declarations: [enclosing, decl("other", 3, 4)],
			comments: [span(text, 2, 1)],
		});

		const [found] = service.commentsFor(idOf("work"));
		expect(found?.form).toBe("standalone");
		expect(found?.placement).toBe("inside");
		expect(service.commentsFor(idOf("other"))).toEqual([]);
	});

	// The same shape one scope in: a member nested in the SAME body is still reachable, which is
	// what stops the rule above from swallowing every doc comment written inside a class.
	it("still leads a member declared inside the same scope", async () => {
		const text = "class C:\n\t# what m does\n\tdef m():\n\t\tpass\n";
		const outer = decl("C", 0, 3);
		outer.range = { start: { line: 0, character: 0 }, end: { line: 3, character: 6 } };
		const member = decl("m", 2, 3);
		member.range = { start: { line: 2, character: 1 }, end: { line: 3, character: 6 } };
		const service = await index({ text, declarations: [outer, member], comments: [span(text, 1, 1)] });

		expect(service.commentsFor(idOf("m"))[0]?.form).toBe("leading");
	});

	it("re-anchors on the next pass rather than leaving a stale symbol", async () => {
		const text = "// what work does\nwork\n";
		const service = await index({ text, declarations: [decl("work", 1, 1)], comments: [span(text, 0, 0)] });
		expect(service.commentsFor(idOf("work"))).toHaveLength(1);

		writeFileSync(path.join(root, "a.fake"), text);
		await service.indexWorkspace();

		expect(service.commentsFor(idOf("work"))).toHaveLength(1);
		expect(store.commentsToScan(50)).toHaveLength(1);
	});

	it("stores nothing for a file whose provider reports no comments", async () => {
		const service = await index({ text: "work\n", declarations: [decl("work", 0, 0)], comments: [] });

		expect(service.commentsFor(idOf("work"))).toEqual([]);
		expect(store.commentsToScan(50)).toEqual([]);
	});
});
