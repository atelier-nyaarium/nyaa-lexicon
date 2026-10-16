import { describe, expect, it } from "bun:test";
import { NoteLinkSchema, NoteOutcomeSchema, NoteSchema } from "../noteShapes.js";

describe("note wire shapes", () => {
	it("strips retired confirmation, doubt and proposal fields", () => {
		const note = NoteSchema.parse({
			symbolId: "symbol",
			recordedAs: "src/file.ts",
			revision: 1,
			text: "Summary",
			summary: "Summary",
			restAt: 8,
			author: null,
			authoredAt: 1,
			editedBy: null,
			editedAt: 2,
			sourceChanged: false,
			links: [],
			confirmedBy: { kind: "person" },
			confirmedAt: 2,
			doubt: { by: null, reason: "misleading", at: 3 },
			proposal: { text: "replacement", baseRevision: 1, by: null, at: 4, links: [] },
		});

		expect(note).toEqual({
			symbolId: "symbol",
			recordedAs: "src/file.ts",
			revision: 1,
			text: "Summary",
			summary: "Summary",
			restAt: 8,
			author: null,
			authoredAt: 1,
			editedBy: null,
			editedAt: 2,
			sourceChanged: false,
			links: [],
		});
	});

	it("accepts saved outcomes and rejects proposed outcomes", () => {
		expect(NoteOutcomeSchema.parse({ outcome: "saved", note: null })).toEqual({ outcome: "saved", note: null });
		expect(NoteOutcomeSchema.safeParse({ outcome: "proposed", note: {} }).success).toBe(false);
	});

	it("accepts withheld refs as a note link state", () => {
		expect(
			NoteLinkSchema.parse({
				written: "project-ref://test-project/keys/server.key",
				current: "project-ref://test-project/keys/server.key",
				state: "withheld",
			}),
		).toMatchObject({ state: "withheld" });
	});
});
