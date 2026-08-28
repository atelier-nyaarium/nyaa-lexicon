import { expect, test } from "bun:test";
import { GDScriptProvider } from "../main";

////////////////////////////////
//  Helpers

function parse(text: string) {
	const provider = new GDScriptProvider();
	provider.initialize("/workspace");
	return provider.parseFile({ module: "scripts/player.gd", contentHash: "h", text });
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
