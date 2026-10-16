import { describe, expect, it } from "bun:test";
import { hashContent } from "@nyaa-lexicon/protocol";
import { stageAll } from "../applyEdits";
import { fromText, type SealedRead, sourceReader } from "../sourceRead";
import { SourceWorkspace } from "../sourceWorkspace";
import type { IndexStore } from "../store";
import { readEvent } from "../watcher";
import { viewsOf } from "./reads";
import { testPolicy } from "./testPolicy";

/** Snapshots expose sealed reads as views. */

////////////////////////////////
//  Helpers

declare const store: IndexStore;

const snapshot = testPolicy(".", { secrets: {}, deny: ["denied/**"] }).current;

const text = (module: string, body: string): SealedRead => fromText(() => body)(module);

const SECRET = "kind: Secret\ndata:\n  token: VALUE\n";

const DOTENV = "TOKEN=hunter2\n";

////////////////////////////////
//  Tests

describe("a sealed read", () => {
	it("holds no text of its own, only the shape of what was found", () => {
		const read = text(".env.local", DOTENV);

		expect(Object.keys(read).sort()).toEqual(["kind", "lossless", "module"]);
		expect(JSON.stringify(read)).not.toContain("hunter2");
		expect(read.module).toBe(".env.local");
	});

	it("is judged for the module it read, whatever another module did with the same bytes", () => {
		const notes = snapshot.view(text("notes.txt", DOTENV));
		const env = snapshot.view(text(".env.local", DOTENV));

		expect(notes).toMatchObject({ kind: "plain", text: DOTENV });
		expect(env.kind).toBe("masked");
		expect(env.kind === "masked" ? env.text : "").not.toContain("hunter2");
	});

	it("views a plain file as itself, hashed as the index hashes it", () => {
		const body = "export const a = 1;\n";

		expect(snapshot.view(text("src/a.ts", body))).toEqual({
			kind: "plain",
			text: body,
			hash: hashContent(body),
			lossless: true,
		});
	});

	it("hashes a guarded file over its blanked text and where each value sits", () => {
		const hashed = (body: string) => {
			const view = snapshot.view(text(".env.local", body));
			if (view.kind !== "masked") throw new Error("expected a masked view");
			return view.hash;
		};

		expect(hashed("TOKEN=hunter2\n")).toBe(hashed("TOKEN=abcdefg\n"));
		expect(hashed("TOKEN=hunter2\n")).not.toBe(hashed("TOKEN=hunter22\n"));
		expect(hashed("TOKEN=hunter2\n")).not.toBe(hashed("TOKEN=\n"));
		expect(hashed("TOKEN=hunter2\n")).not.toBe(hashContent("TOKEN=hunter2\n"));
	});

	it("refuses a denied module and one it cannot read, with a hash that names no byte", () => {
		const denied = snapshot.view(text("denied/a.json", '{"a":"hunter2"}'));
		const gone = snapshot.view(fromText(() => null)(".env.local"));

		expect(denied).toEqual({ kind: "refused", hash: expect.any(String) });
		expect(gone).toEqual({ kind: "refused", hash: expect.any(String) });
		expect(denied).not.toEqual(snapshot.view(text("denied/b.json", '{"a":"hunter2"}')));
	});

	it("slices a masked file with each hidden span read as a mark, and a key as it is", () => {
		const view = snapshot.view(text(".env.local", "TOKEN=hunter2\nOTHER=\n"));
		if (view.kind !== "masked") throw new Error("expected a masked view");
		const line = (from: number, to: number) => ({
			start: { line: 0, character: from },
			end: { line: 0, character: to },
		});

		expect(view.slice({ start: { line: 0, character: 0 }, end: { line: 1, character: 0 } })).toBe(
			"TOKEN(redacted)",
		);
		expect(view.slice(line(0, 5))).toBe("TOKEN");
		expect(view.slice({ start: { line: 9, character: 0 }, end: { line: 9, character: 1 } })).toBeNull();
		expect(view.touches(line(0, 5))).toBe(true);
		expect(view.hidden).toBe(true);
	});

	it("tells a hidden key-path value from the rest of its file", () => {
		const view = snapshot.view(text("deploy.yaml", SECRET));
		if (view.kind !== "masked") throw new Error("expected a masked view");
		const at = (line: number, from: number, to: number) => ({
			start: { line, character: from },
			end: { line, character: to },
		});

		expect(view.touches(at(2, 9, 14))).toBe(true);
		expect(view.touches(at(0, 0, 4))).toBe(false);
		expect(view.omits(at(2, 9, 14))).toBe(false);
	});
});

describe("what a writer may stage", () => {
	it("is the text of a plain file and nothing of a guarded one", () => {
		const views = viewsOf(fromText(() => "add();\n"));
		const edit = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "sum" };

		expect(stageAll([{ module: "src/a.ts", edits: [edit] }], views)).toEqual({
			staged: [{ module: "src/a.ts", text: "sum();\n" }],
		});
	});

	it("refuses a file the policy hides in any part", () => {
		const hiding = (module: string) => snapshot.view(text(module, DOTENV));
		const edit = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "KEY" };

		for (const module of [".env.local", "denied/a.json"]) {
			expect(stageAll([{ module, edits: [edit] }], hiding)).toMatchObject({ applied: false, module });
		}
	});
});

describe("what the compiler refuses", () => {
	it("takes no raw text, no unsealed reader and no unhashed event", () => {
		const never = () => {
			const read = text("a.ts", "x");
			if (read.kind === "text") {
				// @ts-expect-error sealed reads have no text
				hashContent(read.text);
			}
			// @ts-expect-error verdicts use the sealed module
			snapshot.verdict("notes.txt", read);
			// @ts-expect-error sealed reads cannot be forged
			const forged: SealedRead = { kind: "missing", module: "a.ts" };
			// @ts-expect-error workspaces require view readers
			new SourceWorkspace(store, sourceReader("."), ".");
			// @ts-expect-error staging requires view readers
			stageAll([], sourceReader("."));
			// @ts-expect-error event hashing requires a view reader
			readEvent(".", "a.ts");
			return forged;
		};

		expect(never).toBeInstanceOf(Function);
	});
});
