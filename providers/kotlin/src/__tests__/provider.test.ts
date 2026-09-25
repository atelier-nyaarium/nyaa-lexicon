import { expect, test } from "bun:test";
import { FileFactsSchema, handlersFor, PROTOCOL_VERSION } from "@nyaa-lexicon/protocol";
import { KotlinProvider, LANGUAGE, REFERENCE_ROLES, TIERS } from "../main.js";

test("initialize declares identity, every tier but docs, and the roles the provider emits", () => {
	const handlers = handlersFor(new KotlinProvider());

	expect(handlers.initialize({ workspaceRoot: process.cwd(), protocolVersion: PROTOCOL_VERSION })).toMatchObject({
		providerId: "kotlin-provider",
		language: LANGUAGE,
		extensions: [".kt"],
		tiers: TIERS,
		referenceRoles: [...REFERENCE_ROLES],
	});
	expect(Object.entries(TIERS).filter(([, claimed]) => !claimed)).toEqual([["docs", false]]);
});

test("every handler answers, both notifications included, and write operations refuse with a closed reason", () => {
	const handlers = handlersFor(new KotlinProvider());
	handlers.initialize({ workspaceRoot: process.cwd(), protocolVersion: PROTOCOL_VERSION });
	handlers.discoverProject({ workspaceRoot: process.cwd() });

	expect(Object.keys(handlers).sort()).toEqual([
		"bind",
		"discoverProject",
		"forgetModule",
		"initialize",
		"moduleAdmission",
		"moveEdits",
		"parseFile",
		"probeFile",
		"renameEdits",
		"resolveImport",
		"shutdown",
		"typeOf",
	]);
	expect(handlers.shutdown({})).toEqual({});
	expect(handlers.renameEdits({ module: "a.kt", text: "", oldName: "a", newName: "b", sites: [] })).toMatchObject({
		status: "refused",
		reason: "NotImplemented",
	});
	expect(
		handlers.moveEdits({
			module: "a.kt",
			text: "",
			exists: false,
			symbolId: "lexicon kotlin a.kt a.",
			name: "a",
			fromModule: "a.kt",
			toModule: "b.kt",
			role: {},
			importSites: [],
			dependencies: [],
			sites: [],
		}),
	).toMatchObject({ status: "refused", reason: "NotImplemented" });
});

test("a full parse answers every collection; an outline keeps declarations, imports and diagnostics only", () => {
	const handlers = handlersFor(new KotlinProvider());
	handlers.initialize({ workspaceRoot: process.cwd(), protocolVersion: PROTOCOL_VERSION });
	handlers.discoverProject({ workspaceRoot: process.cwd() });
	const text = [
		"package demo",
		"import kotlin.collections.List",
		"// note",
		'class Box { fun run(values: List<Int>): String = values.first().toString() + "!" }',
		"",
	].join("\n");
	const full = handlers.parseFile({ module: "Box.kt", contentHash: "hash", text });
	const outline = handlers.parseFile({ module: "Box.kt", contentHash: "hash", text, depth: "outline" });
	const broken = handlers.parseFile({
		module: "Broken.kt",
		contentHash: "b",
		text: "class Broken {\n",
		depth: "outline",
	});

	expect(FileFactsSchema.parse(full)).toMatchObject({ module: "Box.kt", contentHash: "hash" });
	expect([full.references.length > 0, full.literals.length, full.comments?.length]).toEqual([true, 1, 1]);
	expect(FileFactsSchema.parse(outline)).toMatchObject({
		depth: "outline",
		declarations: full.declarations,
		imports: full.imports,
		references: [],
		literals: [],
		comments: [],
	});
	expect(broken.diagnostics.some((item) => item.severity === "error")).toBe(true);
});
