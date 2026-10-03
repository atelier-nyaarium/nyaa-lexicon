// Toy language for test doubles: `export class X { ... }` declares, `import "./x"` imports, `use X`
// uses and `reexport X from "./x"` forwards. One lexer ignores declarations in strings and braces
// inside bodies.

import { type ToyToken, toySpelled, toyStringValue, toyTokens } from "@nyaa-lexicon/protocol/toy";

////////////////////////////////
//  Interfaces & Types

export interface FakeClass {
	name: string;
	/** Offsets of `export`, the name, and one past the body's closing brace or the name. */
	start: number;
	nameStart: number;
	end: number;
}

export interface FakeImport {
	specifier: string;
	/** Offsets of `import` and one past the specifier. */
	start: number;
	end: number;
}

export interface FakeName {
	name: string;
	/** Offsets of the name. */
	start: number;
	end: number;
}

export interface FakeReExport extends FakeName {
	specifier: string;
}

////////////////////////////////
//  Functions & Helpers

/** One past the brace closing the body that opens at `open`, or undefined when it never closes. */
function bodyEnd(tokens: readonly ToyToken[], open: number): number | undefined {
	let depth = 0;
	for (const token of tokens.slice(open)) {
		if (toySpelled(token, "punct", "{")) depth++;
		else if (toySpelled(token, "punct", "}") && --depth === 0) return token.end;
	}
	return undefined;
}

/** Where the body opens: the first `{` after the name, before the next `export`. */
function bodyOpen(tokens: readonly ToyToken[], from: number): number | undefined {
	for (let at = from; at < tokens.length; at++) {
		if (toySpelled(tokens[at], "word", "export")) return undefined;
		if (toySpelled(tokens[at], "punct", "{")) return at;
	}
	return undefined;
}

/** `export class Name`, with its body when one follows. */
export function fakeClasses(text: string): FakeClass[] {
	const tokens = toyTokens(text);
	const found: FakeClass[] = [];
	for (const [at, opener] of tokens.entries()) {
		const name = tokens[at + 2];
		if (!toySpelled(opener, "word", "export") || !toySpelled(tokens[at + 1], "word", "class")) continue;
		if (name === undefined || !toySpelled(name, "word")) continue;
		const open = bodyOpen(tokens, at + 3);
		const end = open === undefined ? undefined : bodyEnd(tokens, open);
		found.push({ name: name.text, start: opener.start, nameStart: name.start, end: end ?? name.end });
	}
	return found;
}

/** Each `import "specifier"`. */
export function fakeImports(text: string): FakeImport[] {
	const tokens = toyTokens(text);
	return tokens.flatMap((token, at) => {
		const specifier = tokens[at + 1];
		if (!toySpelled(token, "word", "import") || !toySpelled(specifier, "string")) return [];
		const written = specifier as ToyToken;
		return [{ specifier: toyStringValue(written), start: token.start, end: written.end }];
	});
}

/** Each `use Name`. */
export function fakeUses(text: string): FakeName[] {
	const tokens = toyTokens(text);
	return tokens.flatMap((token, at) => {
		const name = tokens[at + 1];
		if (!toySpelled(token, "word", "use") || !toySpelled(name, "word")) return [];
		const written = name as ToyToken;
		return [{ name: written.text, start: written.start, end: written.end }];
	});
}

/** Each `reexport Name from "specifier"`. */
export function fakeReExports(text: string): FakeReExport[] {
	const tokens = toyTokens(text);
	return tokens.flatMap((token, at) => {
		const [name, from, specifier] = tokens.slice(at + 1, at + 4);
		if (!toySpelled(token, "word", "reexport") || !toySpelled(name, "word")) return [];
		if (!toySpelled(from, "word", "from") || !toySpelled(specifier, "string")) return [];
		const written = name as ToyToken;
		return [
			{
				name: written.text,
				start: written.start,
				end: written.end,
				specifier: toyStringValue(specifier as ToyToken),
			},
		];
	});
}
