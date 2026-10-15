import { expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import ts from "typescript";

const RENDER_ROOT = path.join(import.meta.dirname, "..", "render");
const RENDER_BARREL = path.join(import.meta.dirname, "..", "render.ts");

function rendererFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const file = path.join(directory, entry.name);
		if (entry.isDirectory()) return rendererFiles(file);
		return entry.isFile() && file.endsWith(".ts") ? [file] : [];
	});
}

/** Inert in Markdown, so standing in for an interpolation changes no parse but its own position. */
const hole = (index: number) => `LEXHOLE${index}LEX`;

/**
 * The Markdown each template writes, with every interpolation replaced by a marker.
 *
 * Reading the COOKED literal text, so an escaped backtick in source is a backtick here.
 */
function probeOf(node: ts.TemplateExpression): string {
	let markdown = node.head.text;
	for (const [index, span] of node.templateSpans.entries()) {
		markdown += hole(index) + span.literal.text;
	}
	return markdown;
}

/** Marker indices landing inside an inline code span, where a raw value shapes the Markdown. */
function spanned(markdown: string): number[] {
	const inside: number[] = [];
	const walk = (node: { type: string; value?: string; children?: unknown[] }): void => {
		if (node.type === "inlineCode") {
			for (const match of (node.value ?? "").matchAll(/LEXHOLE(\d+)LEX/g)) inside.push(Number(match[1]));
		}
		for (const child of (node.children ?? []) as (typeof node)[]) walk(child);
	};
	walk(fromMarkdown(markdown) as never);
	return inside;
}

function templatesOf(source: ts.SourceFile): ts.TemplateExpression[] {
	const found: ts.TemplateExpression[] = [];
	const walk = (node: ts.Node): void => {
		if (ts.isTemplateExpression(node)) found.push(node);
		ts.forEachChild(node, walk);
	};
	walk(source);
	return found;
}

const sources = [RENDER_BARREL, ...rendererFiles(RENDER_ROOT)].map((file) => {
	const text = readFileSync(file, "utf8");
	return { text, source: ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true) };
});

it("has a renderer to check, holding the one span builder", () => {
	expect(sources.flatMap(({ source }) => templatesOf(source)).length).toBeGreaterThan(50);
	expect(sources.map(({ text }) => text).join("\n")).toContain("export function code(");
});

/**
 * The template is walked and the Markdown is parsed, because neither tool answers this alone: only
 * the AST separates literal text from an interpolation, and only a CommonMark parser decides which
 * backtick opens a span and which closes one.
 */
it("puts no interpolation inside a code span the renderer wrote itself", () => {
	const offenders = sources.flatMap(({ source }) =>
		templatesOf(source).flatMap((template) =>
			spanned(probeOf(template)).map((index) => {
				const expression = template.templateSpans[index]?.expression;
				const line =
					expression === undefined
						? 0
						: source.getLineAndCharacterOfPosition(expression.getStart(source)).line;
				return `${source.fileName}:${line + 1}: ${expression?.getText(source)}`;
			}),
		),
	);
	expect(offenders).toEqual([]);
});

it("builds no code span by concatenation, where the walk above cannot see it", () => {
	const offenders = sources.flatMap(({ source }) => {
		const found: string[] = [];
		const walk = (node: ts.Node): void => {
			if (
				ts.isBinaryExpression(node) &&
				node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
				[node.left, node.right].some((side) => ts.isStringLiteral(side) && side.text.includes("`"))
			) {
				const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
				found.push(`${source.fileName}:${line + 1}: ${node.getText(source)}`);
			}
			ts.forEachChild(node, walk);
		};
		walk(source);
		return found;
	});
	expect(offenders).toEqual([]);
});
