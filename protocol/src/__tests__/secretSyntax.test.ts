import { describe, expect, it } from "bun:test";
import {
	complementOf,
	isVerifiedSyntax,
	type SecretFormat,
	type SecretHazard,
	type SecretNode,
	type SecretSyntax,
	type SecretSyntaxDocument,
	verifySecretSyntax,
} from "../secretSyntax.js";
import { readToy, toyFormat } from "./fixtures/secrets/toyFormat.js";

////////////////////////////////
//  Fixtures

const TEXT = "kind: Secret\ndata: leaked\nitems:\n  - one\n  - two\n";

function verify(text: string, syntax: SecretSyntax = readToy(text), format: SecretFormat = toyFormat) {
	return verifySecretSyntax(format, text, syntax);
}

function reshaped(syntax: SecretSyntax, edit: (nodes: SecretNode[], hazards: SecretHazard[]) => void): SecretSyntax {
	return {
		documents: syntax.documents.map((document): SecretSyntaxDocument => {
			const nodes = document.nodes.map((node) => ({
				...node,
				key: { ...node.key },
				value: { ...node.value },
				children: [...node.children],
				via: [...node.via],
			}));
			const hazards = [...document.hazards];
			edit(nodes, hazards);
			return { nodes, hazards };
		}),
	};
}

function nodeNamed(syntax: SecretSyntax, name: string): number {
	const at = (syntax.documents[0] as SecretSyntaxDocument).nodes.findIndex((node) => node.names.includes(name));
	expect(at).toBeGreaterThan(0);
	return at;
}

////////////////////////////////
//  Tests

describe("complementOf", () => {
	it("returns the parts of a range that sorted spans leave out", () => {
		const spans = [
			{ start: 2, end: 4 },
			{ start: 6, end: 9 },
			{ start: 12, end: 14 },
		];

		expect(complementOf(spans, { start: 0, end: 16 })).toEqual([
			{ start: 0, end: 2 },
			{ start: 4, end: 6 },
			{ start: 9, end: 12 },
			{ start: 14, end: 16 },
		]);
		expect(complementOf(spans, { start: 3, end: 13 })).toEqual([
			{ start: 4, end: 6 },
			{ start: 9, end: 12 },
		]);
		expect(complementOf(spans, { start: 6, end: 9 })).toEqual([]);
		expect(complementOf([], { start: 1, end: 3 })).toEqual([{ start: 1, end: 3 }]);
	});
});

describe("verifySecretSyntax", () => {
	it("accepts a reader that accounts for every byte", () => {
		const verified = verify(TEXT);
		expect(verified.residual).toBe(0);
		expect(verified.hazards).toEqual([[]]);
		expect(isVerifiedSyntax(verified)).toBe(true);
	});

	it("keeps the reader's documents and their identity", () => {
		const syntax = readToy("a: 1\n---\nb: 2\n");
		const verified = verify("a: 1\n---\nb: 2\n", syntax);
		expect(verified.documents).toEqual(syntax.documents);
		expect(verified.documents[1]).toBe(syntax.documents[1] as SecretSyntaxDocument);
		expect(verified.residual).toBe(0);
	});

	it("turns a dropped value into a residual hazard at the worst-case scope", () => {
		const dropped = reshaped(readToy(TEXT), (nodes) => {
			const data = nodes[nodeNamed({ documents: [{ nodes, hazards: [] }] }, "data")] as SecretNode;
			data.value = { start: data.value.end, end: data.value.end };
		});
		const verified = verify(TEXT, dropped);

		expect(verified.residual).toBe(1);
		expect(verified.hazards[0]).toEqual([
			{
				span: { start: TEXT.indexOf(": leaked"), end: TEXT.indexOf("items") },
				within: 0,
				reach: "any",
				reshapes: true,
			},
		]);
	});

	it("widens a declared hazard over the failing bytes beside it", () => {
		const start = TEXT.indexOf("leaked");
		const partial = reshaped(readToy(TEXT), (nodes, hazards) => {
			const data = nodes[nodeNamed({ documents: [{ nodes, hazards }] }, "data")] as SecretNode;
			data.value = { start: data.value.end, end: data.value.end };
			hazards.push({ span: { start, end: start + 2 }, within: 0, reach: "spelled", reshapes: false });
		});
		const verified = verify(TEXT, partial);

		expect(verified.residual).toBe(0);
		expect(verified.hazards[0]).toEqual([
			{ span: { start, end: TEXT.indexOf("items") }, within: 0, reach: "spelled", reshapes: false },
		]);
	});

	it("matches the inert lexicon one token at a time", () => {
		expect(verify("# note\na: 1\n").residual).toBe(0);
		const stray = reshaped(readToy("a: 1\nb: 2\n"), (nodes) => {
			(nodes[1] as SecretNode).key = { start: 0, end: 0 };
		});
		expect(verify("a: 1\nb: 2\n", stray).residual).toBe(1);
	});

	it("replaces a document whose structure cannot be trusted", () => {
		const broken: Array<[string, (nodes: SecretNode[], hazards: SecretHazard[]) => void]> = [
			[
				"a child outside its parent",
				(nodes) => {
					const items = nodes[nodeNamed({ documents: [{ nodes, hazards: [] }] }, "items")] as SecretNode;
					items.value = { start: items.value.start, end: items.value.start };
				},
			],
			[
				"siblings out of order",
				(nodes) => {
					(nodes[0] as SecretNode).children = [...(nodes[0] as SecretNode).children].reverse();
				},
			],
			[
				"a node its parent does not list",
				(nodes) => {
					(nodes[0] as SecretNode).children = (nodes[0] as SecretNode).children.slice(1);
				},
			],
			[
				"a parent out of range",
				(nodes) => {
					(nodes[1] as SecretNode).parent = 99;
				},
			],
			[
				"a hazard within a missing node",
				(_nodes, hazards) => {
					hazards.push({ span: { start: 0, end: 1 }, within: 99, reach: "any", reshapes: false });
				},
			],
			[
				"a span past the text",
				(nodes) => {
					(nodes[1] as SecretNode).value = { start: 0, end: TEXT.length + 1 };
				},
			],
		];
		for (const [name, edit] of broken) {
			const verified = verify(TEXT, reshaped(readToy(TEXT), edit));
			expect(verified.residual, name).toBe(1);
			expect(verified.documents[0]?.nodes, name).toHaveLength(1);
			expect(verified.hazards[0], name).toEqual([
				{ span: { start: 0, end: TEXT.length }, within: 0, reach: "any", reshapes: true },
			]);
		}
	});

	it("takes a child outside its parent only through a via span", () => {
		const text = "base: shared\ncopy: x\n";
		const syntax = reshaped(readToy(text), (nodes) => {
			const base = nodes[1] as SecretNode;
			const copy = nodes[2] as SecretNode;
			nodes.push({
				parent: 2,
				names: ["twin"],
				key: { ...base.key },
				value: { ...base.value },
				children: [],
				via: [],
				virtual: true,
			});
			copy.children = [3];
		});
		const outside = verify(text, syntax);
		expect(outside.residual).toBe(1);

		const inside = reshaped(syntax, (nodes) => {
			(nodes[2] as SecretNode).via = [{ start: 0, end: text.indexOf("\n") }];
		});
		const accepted = verify(text, inside);
		expect(accepted.residual).toBe(0);
		expect(accepted.documents[0]?.nodes).toHaveLength(4);
	});

	it("does not treat a virtual node's bytes as claimed twice", () => {
		const text = "base: shared\ncopy: x\n";
		const syntax = reshaped(readToy(text), (nodes) => {
			const base = nodes[1] as SecretNode;
			nodes.push({
				parent: 2,
				names: ["twin"],
				key: { ...base.key },
				value: { ...base.value },
				children: [],
				via: [],
				virtual: true,
			});
			(nodes[2] as SecretNode).children = [3];
			(nodes[2] as SecretNode).via = [{ start: 0, end: text.indexOf("\n") }];
		});
		expect(verify(text, syntax).residual).toBe(0);
	});

	it("collapses a flood of failing gaps into one residual hazard", () => {
		const text = "x;".repeat(300);
		const items = Array.from(
			{ length: 300 },
			(_, index): SecretNode => ({
				parent: 0,
				names: [String(index)],
				index,
				key: { start: index * 2, end: index * 2 },
				value: { start: index * 2, end: index * 2 + 1 },
				children: [],
				via: [],
				virtual: false,
			}),
		);
		const root: SecretNode = {
			parent: -1,
			names: [],
			key: { start: 0, end: 0 },
			value: { start: 0, end: text.length },
			children: items.map((_, index) => index + 1),
			via: [],
			virtual: false,
		};
		const verified = verify(text, { documents: [{ nodes: [root, ...items], hazards: [] }] });

		expect(verified.residual).toBe(1);
		expect(verified.hazards[0]).toEqual([
			{ span: { start: 1, end: text.length }, within: 0, reach: "any", reshapes: true },
		]);
	});

	it("is minted only by the verifier", () => {
		const syntax = readToy(TEXT);
		expect(isVerifiedSyntax(syntax)).toBe(false);
		const forged = { ...syntax, hazards: [[]], residual: 0 } as unknown as ReturnType<typeof verify>;
		expect(isVerifiedSyntax(forged)).toBe(false);
	});
});
