import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { nodesIn, parseSource } from "@nyaa-lexicon/protocol/ast";
import ts from "typescript";

const SOURCES = path.join(import.meta.dir, "..");

/** Any insert into the notes table, however its conflict clause is written. */
const NOTE_INSERT = /\bINSERT\b[^;]*?\bINTO\s+symbol_notes\b/i;

/** Each string in a file, joined across `+` and template pieces; a substitution reads as one space. */
function stringsOf(file: string): string[] {
	const { source } = parseSource(file, readFileSync(path.join(SOURCES, file), "utf8"));
	return nodesIn(source).flatMap((node) => {
		const text = joinedText(node);
		return text === undefined ? [] : [text];
	});
}

function joinedText(node: ts.Node): string | undefined {
	if (ts.isStringLiteralLike(node)) return node.text;
	if (ts.isTemplateExpression(node)) {
		return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" ");
	}
	if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
		return `${joinedText(node.left) ?? " "}${joinedText(node.right) ?? " "}`;
	}
	return undefined;
}

describe("the notes table's insert", () => {
	it("is written in noteRows.ts alone, so its column list has one owner", () => {
		const writers = readdirSync(SOURCES)
			.filter((name) => name.endsWith(".ts"))
			.filter((name) => stringsOf(name).some((sql) => NOTE_INSERT.test(sql)));
		expect(writers).toEqual(["noteRows.ts"]);
	});
});
