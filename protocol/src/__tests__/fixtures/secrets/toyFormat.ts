// Toy indentation format for reader-contract tests.
// `name: value` is a leaf; `a|b` gives two names.
// `name:` opens a container with indented children.
// `- value` is an item; bare `-` opens one.
// `!a`, `!s`, and `!r` mark any, spelled, or reshaping hazards.
// `---` starts a document; `#` starts a comment.

import type { OffsetRange } from "../../../coordinates.js";
import type {
	SecretFormat,
	SecretHazard,
	SecretNode,
	SecretSyntax,
	SecretSyntaxDocument,
} from "../../../secretSyntax.js";

////////////////////////////////
//  Interfaces & Types

interface Line {
	start: number;
	end: number;
	text: string;
}

interface Builder {
	parent: number;
	names: string[];
	index?: number;
	key: OffsetRange;
	value: OffsetRange;
	children: number[];
	via: OffsetRange[];
	virtual: boolean;
}

////////////////////////////////
//  Reading

const scalars = new WeakMap<SecretSyntaxDocument, Map<number, string>>();

function linesOf(text: string): Line[] {
	const lines: Line[] = [];
	let at = 0;
	for (const raw of text.split("\n")) {
		lines.push({ start: at, end: at + raw.length, text: raw });
		at += raw.length + 1;
	}
	return lines;
}

function readDocument(group: readonly Line[], length: number): SecretSyntaxDocument {
	const first = group[0];
	const last = group[group.length - 1];
	const span =
		first === undefined || last === undefined
			? { start: length, end: length }
			: { start: first.start, end: last.end };
	const nodes: Builder[] = [
		{
			parent: -1,
			names: [],
			key: { start: span.start, end: span.start },
			value: { ...span },
			children: [],
			via: [],
			virtual: false,
		},
	];
	const hazards: SecretHazard[] = [];
	const leaves = new Map<number, string>();
	const open = [{ indent: -1, at: 0 }];
	for (const line of group) {
		const indent = line.text.length - line.text.trimStart().length;
		const body = line.text.slice(indent);
		if (body === "" || body.startsWith("#")) continue;
		while ((open[open.length - 1] as { indent: number }).indent >= indent) open.pop();
		const parent = (open[open.length - 1] as { at: number }).at;
		const start = line.start + indent;
		if (body.startsWith("!")) {
			const flags = /^!([asr]*)/.exec(body)?.[1] ?? "";
			hazards.push({
				span: { start, end: line.end },
				within: parent,
				reach: flags.includes("a") ? "any" : "spelled",
				reshapes: flags.includes("r"),
			});
			continue;
		}
		const at = nodes.length;
		let node: Builder;
		let container = false;
		if (body === "-" || body.startsWith("- ")) {
			const index = (nodes[parent] as Builder).children.filter(
				(child) => (nodes[child] as Builder).index !== undefined,
			).length;
			container = body === "-";
			node = {
				parent,
				names: [String(index)],
				index,
				key: { start, end: start },
				value: container ? { start: start + 1, end: start + 1 } : { start: start + 2, end: line.end },
				children: [],
				via: [],
				virtual: false,
			};
			if (!container) leaves.set(at, body.slice(2).trim());
		} else {
			const match = /^([^:]+):(?: (.*))?$/.exec(body);
			const label = match?.[1] ?? body;
			const rest = match?.[2] ?? "";
			container = rest === "";
			node = {
				parent,
				names: label.split("|"),
				key: { start, end: start + label.length },
				value: container
					? { start: start + label.length, end: start + label.length }
					: { start: start + label.length + 2, end: line.end },
				children: [],
				via: [],
				virtual: false,
			};
			if (!container) leaves.set(at, rest.trim());
		}
		nodes.push(node);
		(nodes[parent] as Builder).children.push(at);
		if (container) open.push({ indent, at });
		for (let owner = parent; owner >= 0; owner = (nodes[owner] as Builder).parent) {
			const value = (nodes[owner] as Builder).value;
			value.end = Math.max(value.end, node.value.end, node.key.end);
		}
	}
	const document: SecretSyntaxDocument = { nodes: nodes as SecretNode[], hazards };
	scalars.set(document, leaves);
	return document;
}

export function readToy(text: string): SecretSyntax {
	const groups: Line[][] = [[]];
	for (const line of linesOf(text)) {
		if (line.text.trim() === "---") groups.push([]);
		else (groups[groups.length - 1] as Line[]).push(line);
	}
	return { documents: groups.map((group) => readDocument(group, text.length)) };
}

////////////////////////////////
//  Format

export const toyFormat: SecretFormat = {
	id: "toy",
	consumers: ["toy"],
	matches: () => true,
	inert: /(?:[ \t\r\n]+|#[^\n]*|---|[:-])/y,
	read: readToy,
	scalar(document, node) {
		const value = scalars.get(document)?.get(node);
		if (value === undefined)
			return { kind: "uncertain", empty: (document.nodes[node]?.children.length ?? 0) === 0 };
		if (value.startsWith("?")) return { kind: "uncertain", empty: false };
		return { kind: "decided", value, empty: value === "" };
	},
	mayName(text, span, names) {
		return names.some((name) => {
			const at = text.indexOf(name, span.start);
			return at >= 0 && at + name.length <= span.end;
		});
	},
};
