import { expect, test } from "bun:test";
import { handlersFor, PROTOCOL_VERSION } from "@nyaa-lexicon/protocol";
import { GDScriptProvider } from "../main";

////////////////////////////////
//  Helpers

function parse(text: string) {
	const handlers = handlersFor(new GDScriptProvider());
	handlers.initialize({ workspaceRoot: process.cwd(), protocolVersion: PROTOCOL_VERSION });
	handlers.discoverProject({ workspaceRoot: process.cwd() });
	return handlers.parseFile({ module: "scripts/player.gd", contentHash: "h", text });
}

////////////////////////////////
//  Tests

// The name of a file-named script is nowhere to select, so the wire carries no span for it.
test("a script with no class_name has no selectionRange, and one with a class_name does", () => {
	const unnamed = parse("extends Node\nvar count = 1\n");
	const root = unnamed.declarations.find((declaration) => declaration.name === "player");
	const count = unnamed.declarations.find((declaration) => declaration.name === "count");
	expect(root).toBeDefined();
	expect(root).not.toHaveProperty("selectionRange");
	expect(count?.selectionRange).toBeDefined();

	const named = parse("class_name Player\nextends Node\n");
	const player = named.declarations.find((declaration) => declaration.name === "Player");
	expect(player?.selectionRange).toEqual({ start: { line: 0, character: 11 }, end: { line: 0, character: 17 } });
});

// Godot measures a class from its class_name or extends line, so a doc comment above it is outside it.
test("a script's range starts at its header, past script annotations and a doc comment", () => {
	const root = (text: string) =>
		parse(text).declarations.find((declaration) => declaration.containerId === undefined)?.range.start;
	const documented = parse("## The player.\n@tool\nextends Node\nvar count = 1\n");

	expect([
		root("## The player.\n@tool\nextends Node\nvar count = 1\n"),
		root("# License\n\nclass_name Player\nextends Node\n"),
		root("## A counter.\nvar count = 1\n"),
	]).toEqual([
		{ line: 2, character: 0 },
		{ line: 2, character: 0 },
		{ line: 0, character: 0 },
	]);
	expect(documented.comments?.map((comment) => [comment.codeBefore, comment.codeAfter])).toEqual([[false, false]]);
});
