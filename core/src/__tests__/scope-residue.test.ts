import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import path from "node:path";
import { readSwept } from "@nyaa-lexicon/protocol";
import { callsTo, parseSource } from "@nyaa-lexicon/protocol/ast";
import ts from "typescript";

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const file = path.join(directory, entry.name);
		return entry.isDirectory() ? sourceFiles(file) : file.endsWith(".ts") ? [file] : [];
	});
}

function ownerName(node: ts.Node): string {
	let functionName: string | undefined;
	for (let at = node.parent; at !== undefined; at = at.parent) {
		if (ts.isClassDeclaration(at) && at.name) return at.name.text;
		if ((ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) && at.name && functionName === undefined) {
			functionName = at.name.getText();
		}
	}
	return functionName ?? "module";
}

const STRUCTURAL_READERS: Record<string, { count: number; reason: string }> = {
	ArrangePlanner: { count: 1, reason: "walks an arrangement closure by the id grammar" },
	InsertPlanner: { count: 1, reason: "checks an inserted declaration against the anchor subtree" },
	MovePlanner: { count: 2, reason: "walks a move closure and checks held declarations" },
	ReplacementPlanner: { count: 2, reason: "checks replacement ranges against nested ids" },
	contains: { count: 2, reason: "answers strict and inclusive scope containment" },
	resolveScope: { count: 1, reason: "resolves a scope by the id grammar" },
};

describe("scope containment ownership", () => {
	it("keeps structural containment calls in scope and planner declarations", () => {
		const root = path.resolve(import.meta.dirname, "..");
		const files = sourceFiles(root).filter((file) => !file.includes(`${path.sep}__tests__${path.sep}`));
		const matches: Record<string, number> = {};
		for (const file of files) {
			const source = readSwept(file);
			if (source === null) continue;
			for (const call of callsTo(parseSource(file, source).source, "isWithin")) {
				const owner = ownerName(call);
				matches[owner] = (matches[owner] ?? 0) + 1;
			}
		}
		const expected = Object.fromEntries(
			Object.entries(STRUCTURAL_READERS).map(([name, reader]) => [name, reader.count]),
		);
		expect(matches).toEqual(expected);
	});
});
