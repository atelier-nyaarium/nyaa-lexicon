import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { calleeOf, callsIn, parseSource } from "@nyaa-lexicon/protocol/ast";
import ts from "typescript";

////////////////////////////////
//  Constants

const REPO_ROOT = join(import.meta.dirname, "../../..");
const ENTRYPOINTS = ["core/src/indexCli.ts", "core/src/gradeCli.ts", "adapters/lsp/src/serve.ts"];

////////////////////////////////
//  Functions & Helpers

function hasPolicySource(source: ts.SourceFile): boolean {
	let found = false;
	const visit = (node: ts.Node): void => {
		if (
			ts.isNewExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === "ProviderSupervisor"
		) {
			const source = node.arguments?.[2];
			found ||=
				source !== undefined &&
				ts.isArrowFunction(source) &&
				ts.isPropertyAccessExpression(source.body) &&
				ts.isIdentifier(source.body.expression) &&
				source.body.expression.text === "policy" &&
				source.body.name.text === "current";
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

function hasProviderAttachment(source: ts.SourceFile): boolean {
	return callsIn(source).some((call) => {
		const callee = calleeOf(call);
		const options = call.arguments[0];
		return (
			callee?.receiver === "policy" &&
			callee.name === "attach" &&
			options !== undefined &&
			ts.isObjectLiteralExpression(options) &&
			options.properties.some(
				(property) =>
					ts.isPropertyAssignment(property) &&
					ts.isIdentifier(property.name) &&
					property.name.text === "providers" &&
					ts.isIdentifier(property.initializer) &&
					property.initializer.text === "supervisor",
			)
		);
	});
}

function sourceOf(file: string): ts.SourceFile {
	return parseSource(file, readFileSync(join(REPO_ROOT, file), "utf8")).source;
}

////////////////////////////////
//  Tests

describe("provider policy entry points", () => {
	it("detects a missing policy source", () => {
		const source = parseSource("control.ts", "new ProviderSupervisor(clock, timings);").source;
		expect(hasPolicySource(source)).toBe(false);
	});

	it.each(ENTRYPOINTS)("gives %s the live policy and provider attachment", (file) => {
		const source = sourceOf(file);
		expect(hasPolicySource(source)).toBe(true);
		expect(hasProviderAttachment(source)).toBe(true);
	});
});
