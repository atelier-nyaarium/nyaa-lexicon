import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const RENDER = path.join(import.meta.dirname, "..", "render.ts");

it("routes every dynamic id through codeSpan", () => {
	const source = readFileSync(RENDER, "utf8");
	const rawId = /`[^`]*\$\{(?!codeSpan\()[^}]*\b(?:symbol|fact|container)Id\b[^}]*\}/;
	expect(source).not.toMatch(rawId);
});
