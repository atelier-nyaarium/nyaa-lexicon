import { describe, expect, it } from "bun:test";
import { makeFixtureArrangeEdits } from "../conformance/fixtureProvider.js";
import { coordinatesOf } from "../coordinates.js";
import { applyEdits } from "../edits.js";
import type { ArrangeEditsRequest, ArrangeImportSite } from "../move.js";
import { composeSymbolId } from "../symbolId.js";
import type { Range } from "../symbols.js";

////////////////////////////////
//  Helpers

const CART = "src/cart.ref";
const ITEMS = "src/items.ref";

function idOf(name: string, module = CART): string {
	return composeSymbolId({ language: "reference", module, descriptors: [{ kind: "term", name }] });
}

function lineAt(line: number) {
	return { line, character: 0 };
}

function lines(from: number, to: number): Range {
	return { start: lineAt(from), end: lineAt(to) };
}

function rangeForText(text: string, value: string): Range {
	const start = text.indexOf(value);
	const range = start === -1 ? undefined : coordinatesOf(text).rangeAt(start, start + value.length);
	if (range === undefined) throw new Error(`missing test text: ${value}`);
	return range;
}

function importSite(text: string, name: string): ArrangeImportSite {
	return {
		symbolId: idOf(name),
		range: rangeForText(text, name),
		specifier: "./cart",
		importKind: "named",
		importedName: name,
		localName: name,
	};
}

function arrange(request: Partial<ArrangeEditsRequest> & Pick<ArrangeEditsRequest, "module" | "text" | "members">) {
	const full: ArrangeEditsRequest = {
		exists: true,
		fromModule: CART,
		toModule: ITEMS,
		importSites: [],
		dependencies: [],
		...request,
	};
	const answer = makeFixtureArrangeEdits(full);
	if (answer.status === "refused") return answer;
	const result = applyEdits(full.text, answer.edits);
	if ("problem" in result) throw new Error(result.problem);
	return { text: result.text, blocked: answer.blocked };
}

////////////////////////////////
//  Tests

describe("the fixture provider arranging declarations", () => {
	it("lands a group sharing one point as one edit, in member order, needing no import between them", () => {
		const result = arrange({
			module: ITEMS,
			text: "export function a() {}\n",
			members: [
				{
					symbolId: idOf("x"),
					name: "x",
					insertion: { text: "\nexport function x() { y(); }\n", position: lineAt(1) },
					sites: [],
				},
				{
					symbolId: idOf("y"),
					name: "y",
					insertion: { text: "\nexport function y() {}\n", position: lineAt(1) },
					sites: [],
				},
			],
			dependencies: [{ name: "y", origin: { kind: "insideClosure", symbolId: idOf("y") } }],
		});

		expect(result).toEqual({
			text: "export function a() {}\n\nexport function x() { y(); }\n\nexport function y() {}\n",
			blocked: [],
		});
	});

	it("reorders the target's own declarations, landing where their removal starts", () => {
		const result = arrange({
			module: ITEMS,
			text: "export function a() {}\n\nexport function b() {}\n\nexport function c() {}\n",
			fromModule: ITEMS,
			members: [
				{
					symbolId: idOf("b", ITEMS),
					name: "b",
					removal: lines(2, 4),
					insertion: { text: "export function b() {}\n", position: lineAt(0) },
					sites: [],
				},
				{
					symbolId: idOf("a", ITEMS),
					name: "a",
					removal: lines(0, 2),
					insertion: { text: "\nexport function a() {}\n\n", position: lineAt(0) },
					sites: [],
				},
			],
		});

		expect(result).toEqual({
			text: "export function b() {}\n\nexport function a() {}\n\nexport function c() {}\n",
			blocked: [],
		});
	});

	it("repoints each referencing import to the target", () => {
		const text = 'import { add } from "./cart";\nimport { sub } from "./cart";\nadd(sub(1), 2);\n';
		const result = arrange({
			module: "src/use.ref",
			text,
			members: [
				{ symbolId: idOf("add"), name: "add", sites: [] },
				{ symbolId: idOf("sub"), name: "sub", sites: [] },
			],
			importSites: [importSite(text, "add"), importSite(text, "sub")],
		});

		expect(result).toEqual({
			text: 'import { add } from "./items";\nimport { sub } from "./items";\nadd(sub(1), 2);\n',
			blocked: [],
		});
	});

	it("removes from the source and blocks the import of the target it cannot write", () => {
		const result = arrange({
			module: CART,
			text: "export function add() {}\n\nexport function keep() { add(); }\n",
			members: [{ symbolId: idOf("add"), name: "add", removal: lines(0, 2), sites: [] }],
			dependencies: [{ name: "add", origin: { kind: "workspaceModule", symbolId: idOf("add"), module: ITEMS } }],
		});

		expect(result).toMatchObject({
			text: "export function keep() { add(); }\n",
			blocked: [{ reason: "NotImplemented" }],
		});
	});

	it("refuses an incoming member the target already declares", () => {
		const result = arrange({
			module: ITEMS,
			text: "export const add = 1;\n",
			members: [
				{
					symbolId: idOf("add"),
					name: "add",
					insertion: { text: "\nexport function add() {}\n", position: lineAt(1) },
					sites: [],
				},
			],
		});

		expect(result).toMatchObject({ status: "refused", reason: "TargetCollision" });
	});
});
