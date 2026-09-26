import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { moduleOutsideWorkspace } from "../refusals";
import { LexiconService } from "../service";
import { fromText, OUTSIDE_WORKSPACE_REASON, type SourceReader, sourceReader } from "../sourceRead";
import { IndexStore } from "../store";
import { readEvent } from "../watcher";
import { fakeSupervisor } from "./fakeProvider";
import { gitInit } from "./gitFixture";

////////////////////////////////
//  Helpers

let root: string;
let outside: string;
let store: IndexStore;

function put(dir: string, relative: string, text: string): void {
	const full = path.join(dir, relative);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, text);
}

function link(target: string, relative: string): void {
	const full = path.join(root, relative);
	rmSync(full, { force: true });
	mkdirSync(path.dirname(full), { recursive: true });
	symlinkSync(target, full);
}

function serve(reader: SourceReader = sourceReader(root)): LexiconService {
	return new LexiconService(store, fakeSupervisor(), reader, root);
}

/** A reader that follows every link, ignoring the workspace edge. */
function following(): SourceReader {
	return fromText((module) => {
		try {
			return readFileSync(path.join(root, module), "utf8");
		} catch {
			return null;
		}
	});
}

beforeEach(async () => {
	root = mkdtempSync(path.join(tmpdir(), "lexicon-contained-"));
	outside = mkdtempSync(path.join(tmpdir(), "lexicon-outside-"));
	store = IndexStore.open(path.join(root, ".index.sqlite")).store;
	put(outside, "secret.fake", "export class Secret {}\n");
	await gitInit(root);
});

afterEach(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("a link whose real path leaves the workspace", () => {
	it("is unclaimed and forgotten once a file becomes one, and its source and writes refuse", async () => {
		put(root, "a.fake", "export class Inside {}\n");
		const service = serve();
		await service.indexWorkspace();
		const [inside] = service.findByName("Inside");
		link(path.join(outside, "secret.fake"), "a.fake");

		const source = service.symbolSource({ symbolId: inside?.symbolId as string });
		expect(() => service.writeModule("a.fake", "export class Written {}\n")).toThrow();
		const outcomes = await service.applyBatch([readEvent(root, "a.fake")]);

		expect({
			source,
			outcome: outcomes.find((outcome) => outcome.module === "a.fake"),
			status: service.moduleStatus("a.fake"),
			read: service.moduleDeclarations("a.fake").read,
			names: [...service.findByName("Inside"), ...service.findByName("Secret")],
			secret: readFileSync(path.join(outside, "secret.fake"), "utf8"),
		}).toEqual({
			source: { found: false, reason: moduleOutsideWorkspace("a.fake") },
			outcome: { module: "a.fake", action: "forgotten", cause: "unclaimed", reason: OUTSIDE_WORKSPACE_REASON },
			status: {
				module: "a.fake",
				exists: false,
				claimed: false,
				unclaimedReason: OUTSIDE_WORKSPACE_REASON,
				indexed: false,
			},
			read: { kind: "missing", detail: OUTSIDE_WORKSPACE_REASON },
			names: [],
			secret: "export class Secret {}\n",
		});
	});

	it("is never indexed when an import reaches it through a directory link", async () => {
		put(root, "root.fake", 'export class Root {}\nimport "./linked/secret.fake";\n');
		link(outside, "linked");
		const service = serve();

		await service.indexWorkspace();

		expect({
			root: service.findByName("Root").length,
			secret: service.findByName("Secret"),
			held: store.contentHashOf("linked/secret.fake"),
		}).toEqual({ root: 1, secret: [], held: null });
	});

	it("forgets facts a link-following read stored, on the next warm scan", async () => {
		link(path.join(outside, "secret.fake"), "a.fake");
		await serve(following()).indexWorkspace();
		const seeded = serve(following()).findByName("Secret").length;

		const service = serve();
		await service.warmupWorkspace();

		expect({ seeded, after: service.findByName("Secret"), held: store.contentHashOf("a.fake") }).toEqual({
			seeded: 1,
			after: [],
			held: null,
		});
	});
});

describe("a link that stays inside the workspace", () => {
	it("is read as a file, and an import through a directory link reaches its target", async () => {
		put(root, "inner/real.fake", "export class Real {}\n");
		put(root, "inner/deep.fake", "export class Deep {}\n");
		put(root, "root.fake", 'export class Root {}\nimport "./innerdir/deep.fake";\n');
		link(path.join(root, "inner", "real.fake"), "alias.fake");
		link(path.join(root, "inner"), "innerdir");
		const service = serve();

		await service.indexWorkspace();

		expect({
			alias: service.moduleStatus("alias.fake"),
			deep: store.contentHashOf("innerdir/deep.fake") !== null,
		}).toEqual({
			alias: {
				module: "alias.fake",
				exists: true,
				claimed: true,
				provider: "fake",
				indexed: true,
				depth: "full",
			},
			deep: true,
		});
	});
});
