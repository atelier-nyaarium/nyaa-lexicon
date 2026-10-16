// Unions Kubernetes YAML 1.1 and provider YAML 1.2 readings.
// YAML 1.2 keeps `<<`; YAML 1.1 expands it as virtual children.
// Aliases point to anchor nodes; errors reshape documents.
// The protocol owns masking.

import { isTooDeep, type OffsetRange, saysTooDeep } from "@nyaa-lexicon/protocol";
import {
	extentOf,
	type ScalarReading,
	SecretBudgetError,
	type SecretFormat,
	type SecretHazard,
	type SecretNode,
	type SecretSyntax,
	type SecretSyntaxDocument,
} from "@nyaa-lexicon/protocol/secretSyntax";
import { isAlias, isMap, isNode, isPair, isScalar, isSeq, parseAllDocuments, parseDocument, type Scalar } from "yaml";
import {
	APOSTROPHE,
	BACKSLASH,
	COLON,
	CR,
	DOLLAR,
	hexRun,
	hexValue,
	isBreak,
	isWord,
	type KeyRead,
	LF,
	QUOTE,
	SLASH,
	SPACE,
	skipBlanks,
	someEscaped,
	someOccurrence,
	TAB,
	unitAt,
} from "./spelling.js";

////////////////////////////////
//  Constants

const MAX_DEPTH = 512;
const MAX_NODES = 3_000_000;
const MAX_VIRTUAL = 100_000;
/** Over-budget documents break from the first error. */
const MAX_ERRORS = 16;
const STR_TAG = "tag:yaml.org,2002:str";
/** YAML 1.1 booleans and nulls; YAML 1.2 differs. */
const AMBIGUOUS_WORD = /^(?:y|n|yes|no|true|false|on|off|null)$/i;
const SAFE_WORD = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const PLAIN_STRING = /^[A-Za-z_/][A-Za-z0-9_./@:+-]*$/;
const INTEGER = /^(?:0|[1-9][0-9]{0,14})$/;
/** Numeric, boolean, null, and merge spellings. */
const OPAQUE_NAME = /^(?:[-+.~0-9]|NaN$|Infinity$|<<$|Symbol\(<<\)$)/;
/** End of a folded key's first word. */
const WHITESPACE = /\s/;
const HASH = 0x23;
const HYPHEN = 0x2d;
const DOT = 0x2e;
/** Flow punctuation ends plain scalars. */
const FLOW_INDICATORS: readonly number[] = [0x2c, 0x5b, 0x5d, 0x7b, 0x7d];

/** Anchor or alias token. */
const ANCHOR = /&([^ \t\r\n,[\]{}]+)/g;
const ALIAS = /\*([^ \t\r\n,[\]{}]+)/g;

const leaves = new WeakMap<SecretSyntaxDocument, Map<number, Scalar | null>>();
/** Anchors for the cached text. */
let declared: { text: string; names: ReadonlySet<string> } | null = null;

type Mutable = { -readonly [Key in keyof SecretNode]: SecretNode[Key] } & { children: number[]; via: OffsetRange[] };

interface Context {
	text: string;
	nodes: Mutable[];
	hazards: SecretHazard[];
	scalars: Map<number, Scalar | null>;
	anchors: Map<string, number>;
	/** Nodes that share their parent's children. */
	enclosed: number[];
	/** Node values grouped by key. */
	held: Array<[number, number]>;
	/** Anchored keys read as values. */
	keyAnchors: Map<string, { span: OffsetRange; scalar: Scalar | null }>;
	/** Merge keys as YAML 1.1 directives. */
	merges: Set<number>;
	names: Map<string, string | null>;
	virtual: { count: number };
}

////////////////////////////////
//  Functions & Helpers

function spanOf(node: unknown, length: number): OffsetRange | null {
	if (!isNode(node) || node.range == null) return null;
	return { start: Math.min(node.range[0], length), end: Math.min(node.range[1], length) };
}

function emptyAt(at: number): OffsetRange {
	return { start: at, end: at };
}

/** Provider plain-key rules. */
function providerName(context: Context, source: string): string | null {
	if (context.names.has(source)) return context.names.get(source) as string | null;
	const document = parseDocument(source, { version: "1.2", prettyErrors: false });
	const contents = document.contents;
	const name = document.errors.length === 0 && isScalar(contents) ? String(contents.value) : null;
	context.names.set(source, name);
	return name;
}

function keyNames(context: Context, key: Scalar, span: OffsetRange): string[] {
	// YAML 1.1 directives use this merge symbol.
	if (typeof key.value === "symbol") return ["<<", String(key.value)];
	const raw = context.text.slice(span.start, span.end);
	const plain = key.type === undefined || key.type === "PLAIN";
	const quote = key.type === "QUOTE_DOUBLE" ? '"' : key.type === "QUOTE_SINGLE" ? "'" : null;
	const inner = quote === null ? raw : raw.slice(1, raw.endsWith(quote) && raw.length > 1 ? -1 : undefined);
	const value = key.value;
	const normalized = value === null ? "null" : typeof value === "object" ? null : String(value);
	const provider =
		plain && !(SAFE_WORD.test(raw) && !AMBIGUOUS_WORD.test(raw)) ? providerName(context, raw) : normalized;
	return [...new Set([provider, normalized, inner].filter((name): name is string => name !== null && name !== ""))];
}

type Anchor = { key: { span: OffsetRange; scalar: Scalar | null } } | { node: number };

/** Latest anchor named `source`. */
function anchorFor(context: Context, source: string): Anchor | null {
	const target = context.anchors.get(source);
	const anchoredKey = context.keyAnchors.get(source);
	const latest = target === undefined ? -1 : (context.nodes[target] as Mutable).value.start;
	if (anchoredKey !== undefined && anchoredKey.span.start > latest) return { key: anchoredKey };
	return target === undefined ? null : { node: target };
}

/** Selecting an alias key hides its anchor. */
function readKeyAlias(context: Context, key: unknown, pair: number): void {
	if (!isAlias(key)) return;
	const anchor = anchorFor(context, key.source);
	if (anchor === null) return;
	const read = context.nodes[pair] as Mutable;
	if ("key" in anchor) {
		read.via.push(anchor.key.span);
		return;
	}
	const held = context.nodes[anchor.node] as Mutable;
	read.via.push(held.value, ...held.via);
}

function readingOf(scalar: Scalar | null | undefined): ScalarReading {
	if (scalar == null) return { kind: "uncertain", empty: true };
	const { value } = scalar;
	if (value === null) return { kind: "uncertain", empty: true };
	if (scalar.tag !== undefined && scalar.tag !== STR_TAG) return { kind: "uncertain", empty: value === "" };
	if (typeof value === "string") {
		const plain = scalar.type === undefined || scalar.type === "PLAIN";
		const known = !plain || scalar.tag === STR_TAG || (PLAIN_STRING.test(value) && !AMBIGUOUS_WORD.test(value));
		return known ? { kind: "decided", value, empty: value === "" } : { kind: "uncertain", empty: value === "" };
	}
	const source = scalar.source ?? "";
	if (typeof value === "number" && INTEGER.test(source)) return { kind: "decided", value: source, empty: false };
	if (typeof value === "boolean" && /^(?:true|True|TRUE|false|False|FALSE)$/.test(source))
		return { kind: "decided", value: String(value), empty: false };
	return { kind: "uncertain", empty: false };
}

function addNode(
	context: Context,
	x: unknown,
	parent: number,
	names: string[],
	index: number | undefined,
	key: OffsetRange,
	fallback: number,
	depth: number,
): number {
	if (depth > MAX_DEPTH) throw new SecretBudgetError("depth");
	if (context.nodes.length >= MAX_NODES) throw new SecretBudgetError("size");
	const { nodes } = context;
	const at = nodes.length;
	const value = spanOf(x, context.text.length) ?? emptyAt(Math.min(fallback, context.text.length));
	const node: Mutable = {
		parent,
		names,
		...(index === undefined ? {} : { index }),
		key,
		value,
		children: [],
		via: [],
		virtual: false,
	};
	nodes.push(node);
	// Anchors include their own start.
	if (isNode(x) && !isAlias(x) && typeof x.anchor === "string") context.anchors.set(x.anchor, at);
	if (isAlias(x)) {
		const anchor = anchorFor(context, x.source);
		if (anchor === null) {
			context.hazards.push({ span: value, within: Math.max(parent, 0), reach: "spelled", reshapes: false });
		} else if ("key" in anchor) {
			node.via = [anchor.key.span];
			context.scalars.set(at, anchor.key.scalar);
		} else {
			const owner = nodes[anchor.node] as Mutable;
			node.children = owner.children;
			node.via = [owner.value, ...owner.via];
			if (parent === anchor.node) context.enclosed.push(at);
			if (context.scalars.has(anchor.node)) context.scalars.set(at, context.scalars.get(anchor.node) ?? null);
		}
	} else if (isMap(x)) {
		addMap(context, x, at, node, depth);
	} else if (isSeq(x)) {
		addSeq(context, x, at, node, depth);
	} else if (isScalar(x)) {
		context.scalars.set(at, x);
	} else {
		context.scalars.set(at, null);
	}
	return at;
}

/** Token span, including descendants. */
function tokenExtent(token: unknown, found: OffsetRange): void {
	if (typeof token !== "object" || token === null) return;
	const { offset, source } = token as { offset?: unknown; source?: unknown };
	if (typeof offset === "number") {
		found.start = Math.min(found.start, offset);
		found.end = Math.max(found.end, offset + (typeof source === "string" ? source.length : 0));
	}
	for (const child of Object.values(token)) tokenExtent(child, found);
}

/** Token-held pair omitted by composition. */
function droppedBy(pair: unknown, length: number): OffsetRange | null {
	const item = (pair as { srcToken?: { key?: unknown; value?: unknown } }).srcToken;
	const { key, value } = pair as { key?: unknown; value?: unknown };
	const found = { start: length, end: 0 };
	if (item?.key != null && key == null) tokenExtent(item.key, found);
	if (item?.value != null && value == null) tokenExtent(item.value, found);
	return found.end > found.start ? { start: found.start, end: Math.min(found.end, length) } : null;
}

/** Alias-readable node for a collection key. */
function addKeyNodes(context: Context, key: unknown, span: OffsetRange | null, at: number, depth: number): number {
	if (!(isMap(key) || isSeq(key)) || span === null) return -1;
	const holder = addNode(context, key, at, [], undefined, emptyAt(span.start), span.start, depth);
	(context.nodes[at] as Mutable).children.push(holder);
	return holder;
}

function addMap(context: Context, map: unknown, at: number, owner: Mutable, depth: number): void {
	if (!isMap(map)) return;
	const merges: Array<{ child: number; source: unknown }> = [];
	for (const pair of map.items) {
		if (!isPair(pair)) continue;
		const dropped = droppedBy(pair, context.text.length);
		if (dropped !== null) context.hazards.push({ span: dropped, within: at, reach: "spelled", reshapes: false });
		const key = pair.key;
		const keySpan = spanOf(key, context.text.length);
		const after = keySpan?.end ?? owner.value.start;
		let names: string[];
		if (isNode(key) && !isAlias(key) && typeof key.anchor === "string" && keySpan !== null)
			context.keyAnchors.set(key.anchor, { span: keySpan, scalar: isScalar(key) ? key : null });
		if (isScalar(key) && keySpan !== null) {
			names = keyNames(context, key, keySpan);
		} else {
			// The value follows the reader's key name.
			names = [];
			const start = keySpan?.start ?? after;
			const end = Math.max(after, spanOf(pair.value, context.text.length)?.end ?? after);
			context.hazards.push({ span: { start, end }, within: at, reach: "spelled", reshapes: false });
		}
		const holder = addKeyNodes(context, key, keySpan, at, depth + 1);
		// Key containers end before pair values.
		const keyed = holder >= 0 && keySpan !== null ? emptyAt(keySpan.end) : (keySpan ?? emptyAt(after));
		const child = addNode(context, pair.value, at, names, undefined, keyed, after, depth + 1);
		if (holder >= 0) context.held.push([holder, child]);
		readKeyAlias(context, key, child);
		owner.children.push(child);
		if (isScalar(key) && typeof key.value === "symbol") {
			merges.push({ child, source: pair.value });
			context.merges.add(child);
		}
	}
	for (const merge of merges) addMerged(context, at, owner, merge.child, merge.source);
}

function addSeq(context: Context, seq: unknown, at: number, owner: Mutable, depth: number): void {
	if (!isSeq(seq)) return;
	let previous = owner.value.start;
	seq.items.forEach((item, position) => {
		const span = spanOf(item, context.text.length);
		const start = span?.start ?? previous;
		const names = [String(position)];
		if (isPair(item)) {
			const pairKey = spanOf(item.key, context.text.length) ?? emptyAt(start);
			const valueSpan = spanOf(item.value, context.text.length) ?? emptyAt(pairKey.end);
			const entry = addNode(context, null, at, names, position, emptyAt(pairKey.start), pairKey.start, depth + 1);
			const holder = context.nodes[entry] as Mutable;
			holder.value = { start: pairKey.start, end: Math.max(pairKey.end, valueSpan.end) };
			const keyNames_ = isScalar(item.key) ? keyNames(context, item.key, pairKey) : [];
			holder.children.push(
				addNode(context, item.value, entry, keyNames_, undefined, pairKey, pairKey.end, depth + 2),
			);
			owner.children.push(entry);
			previous = holder.value.end;
			return;
		}
		owner.children.push(addNode(context, item, at, names, position, emptyAt(start), start, depth + 1));
		previous = span?.end ?? previous;
	});
}

/** Virtual children from a merge key. */
function addMerged(context: Context, at: number, owner: Mutable, merge: number, value: unknown): void {
	const { nodes } = context;
	const sources: number[] = [];
	const consider = (index: number, source: unknown) => {
		const found = nodes[index] as Mutable;
		if (isMap(source)) {
			sources.push(index);
			owner.via.push(found.value, ...found.via);
		} else if (isAlias(source) && found.via.length > 0) {
			sources.push(index);
			owner.via.push(...found.via);
		}
	};
	if (isSeq(value)) {
		for (const [position, item] of (nodes[merge] as Mutable).children.entries())
			consider(item, value.items[position]);
	} else {
		consider(merge, value);
	}
	const taken = new Set<string>();
	for (const index of sources) {
		for (const child of (nodes[index] as Mutable).children) {
			if (context.merges.has(child)) continue;
			const original = nodes[child] as Mutable;
			const identity = `${original.key.start}:${original.value.start}:${original.names.join(",")}`;
			if (taken.has(identity)) continue;
			taken.add(identity);
			context.virtual.count += 1;
			if (context.virtual.count > MAX_VIRTUAL) throw new SecretBudgetError("size");
			const copy: Mutable = {
				parent: at,
				names: original.names,
				key: original.key,
				value: original.value,
				children: original.children,
				via: original.via,
				virtual: true,
			};
			if (original.children === owner.children) context.enclosed.push(nodes.length);
			owner.children.push(nodes.length);
			nodes.push(copy);
		}
	}
}

/**
 * Reverse traversal settles recovered child extents.
 */
function widenContainers(nodes: Mutable[]): void {
	for (let at = nodes.length - 1; at > 0; at--) {
		const node = nodes[at] as Mutable;
		if (node.virtual) continue;
		const extent = extentOf(node);
		const value = (nodes[node.parent] as Mutable).value;
		value.start = Math.min(value.start, extent.start);
		value.end = Math.max(value.end, extent.end);
	}
}

function readYaml(text: string): SecretSyntax {
	let parsed: ReturnType<typeof parseAllDocuments>;
	try {
		parsed = parseAllDocuments(text, {
			version: "1.1",
			merge: true,
			uniqueKeys: false,
			prettyErrors: false,
			keepSourceTokens: true,
		});
	} catch (failure) {
		if (isTooDeep(failure)) throw new SecretBudgetError("depth");
		throw failure;
	}
	const names = new Map<string, string | null>();
	const virtual = { count: 0 };
	const documents: SecretSyntaxDocument[] = [];
	for (const document of parsed) {
		const context: Context = {
			text,
			nodes: [],
			hazards: [],
			scalars: new Map(),
			anchors: new Map(),
			enclosed: [],
			held: [],
			keyAnchors: new Map(),
			merges: new Set(),
			names,
			virtual,
		};
		const contents = document.contents;
		const range = spanOf(contents, text.length);
		const start = range?.start ?? Math.min(document.range?.[0] ?? 0, text.length);
		addNode(context, contents, -1, [], undefined, emptyAt(start), start, 0);
		for (const at of context.enclosed) {
			const alias = context.nodes[at] as Mutable;
			alias.children = (context.nodes[alias.parent] as Mutable).children.filter((child) => child !== at);
		}
		const errors = document.errors;
		for (const error of errors.slice(0, MAX_ERRORS)) {
			if (saysTooDeep(error.message)) throw new SecretBudgetError("depth");
			const from = Math.min(error.pos[0], text.length);
			context.hazards.push({
				span: { start: from, end: Math.min(error.pos[1], text.length) },
				within: 0,
				reach: "spelled",
				reshapes: true,
			});
		}
		if (errors.length > MAX_ERRORS) {
			const from = Math.min(errors[MAX_ERRORS]?.pos[0] ?? 0, text.length);
			context.hazards.push({ span: { start: from, end: text.length }, within: 0, reach: "any", reshapes: true });
		}
		widenContainers(context.nodes);
		for (const [holder, pair] of context.held) {
			const end = (context.nodes[holder] as Mutable).value.end;
			const entry = context.nodes[pair] as Mutable;
			if (entry.key.start < end) entry.key = emptyAt(end);
			if (entry.value.start < end) entry.value = { start: end, end: Math.max(entry.value.end, end) };
		}
		const result: SecretSyntaxDocument = { nodes: context.nodes, hazards: context.hazards };
		leaves.set(result, context.scalars);
		documents.push(result);
	}
	return { documents };
}

////////////////////////////////
//  Prefilter

/** Plain-scalar continuation. */
function continuesScalar(code: number): boolean {
	return isWord(code) || code === DOLLAR || code === DOT || code === HYPHEN || code === SLASH;
}

function isSpaceAt(text: string, at: number): boolean {
	return at < text.length && WHITESPACE.test(text[at] as string);
}

/** Key ends at colon, flow punctuation, or break. */
function endsKey(text: string, end: number): boolean {
	const next = skipBlanks(text, end);
	const code = unitAt(text, next);
	if (code === -1 || code === COLON || FLOW_INDICATORS.includes(code)) return true;
	return isBreak(code) || (code === HASH && next > end);
}

/** Finds expected quote; open quotes may consume the last unit. */
function endsQuoted(text: string, end: number, folded: boolean): boolean {
	const after = unitAt(text, end);
	if (after === QUOTE || after === APOSTROPHE || after === -1 || isBreak(after)) return true;
	if (folded && isSpaceAt(text, end)) return true;
	return unitAt(text, end + 1) === -1 || isBreak(unitAt(text, end + 1));
}

/**
 * Whether the word at `start` is a whole key.
 * Folded keys may break at any space.
 */
function isKeyToken(text: string, start: number, end: number, folded: boolean): boolean {
	const before = unitAt(text, start - 1);
	if ((before === QUOTE || before === APOSTROPHE) && endsQuoted(text, end, folded)) return true;
	// Anchors and tags may prefix unusual scalars.
	if (continuesScalar(before) && continuesScalar(text.charCodeAt(start))) return false;
	return (folded && isSpaceAt(text, end)) || endsKey(text, end);
}

const ESCAPES = new Map<number, number>([
	[0x30, 0x00],
	[0x61, 0x07],
	[0x62, 0x08],
	[0x65, 0x1b],
	[0x66, 0x0c],
	[0x6e, LF],
	[0x72, CR],
	[0x74, TAB],
	[0x76, 0x0b],
	[0x4e, 0x85],
	[0x5f, 0xa0],
	[0x4c, 0x2028],
	[0x50, 0x2029],
	[SPACE, SPACE],
	[QUOTE, QUOTE],
	[SLASH, SLASH],
	[BACKSLASH, BACKSLASH],
	[TAB, TAB],
]);

/** Closing quote, or end of text. */
function closeOf(text: string, start: number): number {
	for (let at = start; at < text.length; at++) {
		const code = text.charCodeAt(at);
		if (code === BACKSLASH) at += 1;
		else if (code === QUOTE) return at;
	}
	return text.length;
}

/**
 * Bad escapes may consume the closing quote.
 * Keys crossing lines fold based on indentation.
 * Unclosed keys still count as spellings.
 */
function readQuoted(text: string, start: number, name: string, limit: number): KeyRead {
	const close = closeOf(text, start);
	let at = start;
	let put = 0;
	let live = true;
	const emit = (unit: number) => {
		if (live && name.charCodeAt(put) === unit) put += 1;
		else live = false;
	};
	for (let line = start; line < close; line++) {
		const code = text.charCodeAt(line);
		if (code === LF || code === CR) return { found: true, end: close };
	}
	if (close === text.length) return { found: true, end: close };
	while (at < close && live) {
		const code = text.charCodeAt(at);
		if (code !== BACKSLASH) {
			emit(code);
			at += 1;
			continue;
		}
		const next = text.charCodeAt(at + 1);
		const mapped = ESCAPES.get(next);
		if (mapped !== undefined) {
			emit(mapped);
			at += 2;
		} else {
			const length = next === 0x78 ? 2 : next === 0x75 ? 4 : next === 0x55 ? 8 : 0;
			const digits = text.slice(at + 2, Math.min(at + 2 + length, close + 1));
			const point = length > 0 && hexRun(digits, 0, length) === length ? hexValue(digits, 0, length) : -1;
			const written =
				point >= 0 && point <= 0x10ffff
					? String.fromCodePoint(point)
					: text.slice(at, Math.min(at + 2 + length, close + 1));
			for (let unit = 0; unit < written.length; unit++) emit(written.charCodeAt(unit));
			at += 2 + length;
		}
	}
	return { found: live && put === name.length && close <= limit, end: close };
}

/** Anchors in the cached text. */
function declaredAnchors(text: string): ReadonlySet<string> {
	if (declared === null || declared.text !== text)
		declared = { text, names: new Set([...text.matchAll(ANCHOR)].map((match) => match[1] as string)) };
	return declared.names;
}

/** Aliases can stand for any anchor name. */
function readsAnchor(text: string, span: OffsetRange): boolean {
	const star = text.indexOf("*", span.start);
	if (star === -1 || star >= span.end) return false;
	const names = declaredAnchors(text);
	if (names.size === 0) return false;
	for (const match of text.slice(star, span.end).matchAll(ALIAS)) if (names.has(match[1] as string)) return true;
	return false;
}

/** Whether a key in the span spells `name`. */
function spells(text: string, span: OffsetRange, name: string): boolean {
	if (OPAQUE_NAME.test(name) || AMBIGUOUS_WORD.test(name)) return true;
	// A folded key's first word may spell the full name.
	const word = name.split(WHITESPACE, 1)[0] as string;
	const folded = word.length < name.length;
	const whole = (start: number, end: number) => isKeyToken(text, start, end, folded);
	return (
		someOccurrence(text, word, span, whole) ||
		(word.includes("'") && someOccurrence(text, word.replaceAll("'", "''"), span, whole)) ||
		someEscaped(text, span, name, (start, before) =>
			before === QUOTE && unitAt(text, start - 2) !== BACKSLASH ? readQuoted(text, start, name, span.end) : null,
		)
	);
}

////////////////////////////////
//  Format

export const yamlFormat: SecretFormat & { id: "yaml" } = {
	id: "yaml",
	consumers: ["Kubernetes (YAML 1.1 with merge keys)", "YAML 1.2 parsers"],
	matches: (module) => {
		const lower = module.toLowerCase();
		return lower.endsWith(".yaml") || lower.endsWith(".yml") || lower.endsWith(".kube/config");
	},
	inert: /(?:[ \t\r\n]+|\u{FEFF}|#[^\n]*|%[^\n]*|(?:---|\.\.\.)(?=\s|$)|&[^ \t\r\n,[\]{}]*|!<[^>]*>|![^ \t\r\n,[\]{}]*|[-?:,[\]{}])/uy,
	read: readYaml,
	scalar(document, node) {
		const held = leaves.get(document);
		if (held === undefined) return { kind: "uncertain", empty: false };
		return held.has(node)
			? readingOf(held.get(node))
			: { kind: "uncertain", empty: (document.nodes[node]?.children.length ?? 0) === 0 };
	},
	mayName: (text, span, names) =>
		names.length > 0 && (readsAnchor(text, span) || names.some((name) => spells(text, span, name))),
};
