// The SOLE owner of the symbol id grammar: composer, parser, predicates.
//
// Shape: `lexicon <language> <module> <descriptors>`, modelled on SCIP's descriptor scheme.
// Space-separated because colons collide with Windows drive letters. Names carrying a structural
// character are backtick-quoted and spaces in the module are percent-encoded, so the field count
// stays stable.

import { Cursor, err, ok, type ParseFailure, type ParseResult, safeDigits } from "./cursor.js";

////////////////////////////////
//  Interfaces & Types

export type DescriptorKind = "namespace" | "type" | "term" | "method" | "parameter" | "typeParameter" | "meta";

export interface Descriptor {
	kind: DescriptorKind;
	name: string;
	/**
	 * Tells two same-named siblings apart. One field, two meanings, and they differ in DURABILITY.
	 *
	 * A method's is arity or overload index, which moves only when the signature moves. A document
	 * section's is occurrence order, which moves when anything is inserted above it. So a section id
	 * can change while that section did not, and only an explicit rename or move migrates recorded
	 * knowledge. Order is used anyway because a repeated heading has no other intrinsic identity,
	 * and refusing to identify it at all would leave a real section unsearchable.
	 *
	 * Carried by `method`, `namespace`, `type` and `meta`. A parameter and a type parameter spend
	 * their brackets on the name, and a term's dot is the suffix the method form already claims.
	 */
	disambiguator?: string;
	/** Which declaration of one name path in a file this is, from 2 in source order; the first carries none. */
	occurrence?: number;
}

export interface SymbolId {
	language: string;
	module: string;
	descriptors: Descriptor[];
	/** Ordinal for a function-scoped symbol, since two locals may share a name. */
	local?: number;
}

/** What a malformed id still spells. */
export interface SymbolIdPrefix {
	/** The descriptors parsed before the failure; every descriptor when there is none. */
	descriptors: Descriptor[];
	failure: ParseFailure | null;
	/** The descriptor text from the failing descriptor on; empty when everything parsed. */
	rest: string;
}

interface IdHead {
	language: string;
	module: string;
	local?: number;
}

interface DescriptorFailure {
	failure: ParseFailure;
	/** The text from the failing descriptor on. */
	rest: string;
}

////////////////////////////////
//  Constants

export const SYMBOL_SCHEME = "lexicon";
export const ANONYMOUS_NAMESPACE = "(anonymous)";

const KIND_SUFFIX: Record<Exclude<DescriptorKind, "parameter" | "typeParameter">, string> = {
	namespace: "/",
	type: "#",
	term: ".",
	method: ").",
	meta: ":",
};

const SUFFIX_KIND = new Map<string, DescriptorKind>([
	["/", "namespace"],
	["#", "type"],
	[".", "term"],
	[":", "meta"],
]);

/** Characters that would otherwise end or split a descriptor, so a name carrying one is quoted. */
const STRUCTURAL = new Set([" ", "/", "#", ".", ":", "(", ")", "[", "]", "`"]);

/** A disambiguator sits raw between parens, so anything that could close them early is refused. */
const DISAMBIGUATOR_RE = /^[A-Za-z0-9._-]+$/;

const DIGITS_RE = /^[0-9]+$/;

////////////////////////////////
//  Functions & Helpers

/**
 * Normalize a module path so one file yields one id on every host.
 *
 * NFC because macOS stores filenames decomposed and Linux composed, so the same file would
 * otherwise mint two ids. Absolute paths are refused because they embed a machine's layout, and
 * escaping paths because two files could collapse onto one id.
 */
export function normalizeModulePath(raw: string): string {
	const forward = raw.normalize("NFC").replace(/\\/g, "/");

	if (forward.startsWith("/") || /^[A-Za-z]:\//.test(forward)) {
		throw new Error(`module path must be workspace-relative, got absolute: ${raw}`);
	}
	// Encodable whitespace is only the space; any control character in a path is pathological.
	if (/\p{Cc}/u.test(forward)) {
		throw new Error(`module path must not contain control characters: ${JSON.stringify(raw)}`);
	}

	const parts: string[] = [];
	for (const part of forward.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") throw new Error(`module path must not escape the workspace, got: ${raw}`);
		parts.push(part);
	}

	if (parts.length === 0) throw new Error(`module path is empty: ${raw}`);
	return parts.join("/");
}

/**
 * Spaces are legal in real paths, so they are encoded rather than refused.
 *
 * Exported because the fact id grammar shares this encoding deliberately. One module has to spell
 * the same in both, and a second implementation of that is the bug class this project forbids.
 */
export function encodeModuleField(module: string): string {
	return module.replace(/%/g, "%25").replace(/ /g, "%20");
}

/** One pass, so an encoded literal percent cannot be decoded twice. */
export function decodeModuleField(field: string): string {
	return field.replace(/%(25|20)/g, (_, g) => (g === "25" ? "%" : " "));
}

/** The parser must accept exactly what the composer emits, or an id becomes host-dependent. */
export function isCanonicalModule(module: string): boolean {
	try {
		return normalizeModulePath(module) === module;
	} catch {
		return false;
	}
}

/** Quote only when bare parsing would break; backticks double, as in SCIP. NFC: canonical id, source-form name. */
export function quoteName(name: string): string {
	if (name === "") throw new Error("a descriptor name cannot be empty");
	const nfc = name.normalize("NFC");
	for (const ch of nfc) {
		if (STRUCTURAL.has(ch)) return `\`${nfc.replace(/`/g, "``")}\``;
	}
	return nfc;
}

/** `[n]` after the name, or after a parameter's brackets, and before any suffix. */
function encodeOccurrence(d: Descriptor): string {
	if (d.occurrence === undefined) return "";
	if (!Number.isSafeInteger(d.occurrence) || d.occurrence < 2) {
		throw new Error(`occurrence must be an integer of 2 or more, got: ${d.occurrence}`);
	}
	return `[${d.occurrence}]`;
}

function encodeDescriptor(d: Descriptor): string {
	const name = quoteName(d.name);
	if (d.disambiguator !== undefined && !DISAMBIGUATOR_RE.test(d.disambiguator)) {
		throw new Error(`disambiguator must match ${DISAMBIGUATOR_RE}, got: ${JSON.stringify(d.disambiguator)}`);
	}
	const occurrence = encodeOccurrence(d);

	// Parens plus a dot ARE the method form, which is what separates it from a term of one name.
	if (d.kind === "method") return `${name}(${d.disambiguator ?? ""})${occurrence}.`;

	// Refused rather than ignored, because dropping one collapses two symbols onto a single id.
	// A parameter and a type parameter spend their brackets on the name; a term's suffix is the
	// dot the method form already claims, so `x(2).` could only ever read back as a method.
	if (d.kind === "parameter" || d.kind === "typeParameter" || d.kind === "term") {
		if (d.disambiguator !== undefined) {
			throw new Error(`a ${d.kind} descriptor has no slot for a disambiguator`);
		}
		if (d.kind === "parameter") return `(${name})${occurrence}`;
		// Digits alone would read back as an occurrence of whatever precedes the brackets.
		if (d.kind === "typeParameter" && DIGITS_RE.test(d.name)) {
			throw new Error(`a type parameter cannot be named by digits alone, got: ${d.name}`);
		}
		if (d.kind === "typeParameter") return `[${name}]${occurrence}`;
		return `${name}${occurrence}${KIND_SUFFIX.term}`;
	}

	const suffix = KIND_SUFFIX[d.kind];
	const disambiguated = d.disambiguator === undefined ? name : `${name}(${d.disambiguator})`;
	return `${disambiguated}${occurrence}${suffix}`;
}

/** Normalizes the module here, so a provider cannot mint a host-dependent id by forgetting to. */
export function composeSymbolId(id: SymbolId): string {
	if (id.language === "" || /\s/.test(id.language)) {
		throw new Error(`language must be a non-empty slug with no whitespace, got: ${JSON.stringify(id.language)}`);
	}

	const module = encodeModuleField(normalizeModulePath(id.module));

	if (id.local !== undefined) {
		// Refused rather than ignored: silently dropping descriptors would map two distinct
		// symbols onto one id.
		if (id.descriptors.length > 0) throw new Error("a local symbol cannot also carry descriptors");
		if (!Number.isSafeInteger(id.local) || id.local < 0) {
			throw new Error(`local ordinal must be a safe non-negative integer, got: ${id.local}`);
		}
		return `${SYMBOL_SCHEME} ${id.language} ${module} local${id.local}`;
	}

	if (id.descriptors.length === 0) throw new Error("a non-local symbol needs at least one descriptor");
	return `${SYMBOL_SCHEME} ${id.language} ${module} ${id.descriptors.map(encodeDescriptor).join("")}`;
}

/** Bare names stop at the first structural character, which is the caller's suffix. */
function readName(c: Cursor): string | null {
	if (c.peek() === "`") {
		c.next();
		let out = "";
		while (c.good()) {
			if (c.peek() === "`") {
				c.next();
				if (c.peek() === "`") {
					out += c.next();
					continue;
				}
				return out === "" ? null : out;
			}
			out += c.next();
		}
		return null;
	}

	const out = c.takeWhile((ch) => !STRUCTURAL.has(ch));
	return out === "" ? null : out;
}

/** `[n]` after a name or its parens, or nothing; the bracket opening a type parameter never sits there. */
function readOccurrence(c: Cursor): ParseResult<number | undefined> {
	if (c.peek() !== "[") return ok(undefined);
	c.next();
	const digits = c.takeWhile((ch) => ch >= "0" && ch <= "9");
	if (digits === "") return err(c.fail("expected an occurrence ordinal"));
	const occurrence = safeDigits(digits);
	if (occurrence === null || occurrence < 2) return err(c.fail(`occurrence must be 2 or more, got ${digits}`));
	if (c.peek() !== "]") return err(c.fail("expected ] to close the occurrence"));
	c.next();
	return ok(occurrence);
}

/**
 * Token stage collapsed on purpose, per docs/parsing.md rule 2: the grammar is non-recursive and
 * the input is machine-generated, so a token type would carry no information the caller can use.
 */
function parseDescriptors(c: Cursor, out: Descriptor[]): DescriptorFailure | null {
	let guard = -1;
	// The mark is the failing descriptor's start, so rewinding to it reads the rest through the cursor.
	const failed = (failure: ParseFailure): DescriptorFailure => {
		c.resetToMark();
		return { failure, rest: c.takeWhile(() => true) };
	};

	while (c.good()) {
		// Asserted rather than reasoned about, since a future branch could stall the loop.
		if (c.offset <= guard) throw new Error("parseDescriptors failed to advance");
		guard = c.offset;
		c.mark();

		const ch = c.peek();

		if (ch === "(" || ch === "[") {
			const close = ch === "(" ? ")" : "]";
			c.next();
			const name = readName(c);
			if (name === null) return failed(c.fail("expected a parameter name"));
			if (ch === "[" && DIGITS_RE.test(name)) {
				return failed(c.fail("a type parameter cannot be named by digits alone"));
			}
			if (c.peek() !== close) return failed(c.fail(`expected ${close} to close the parameter`));
			c.next();
			const occurrence = readOccurrence(c);
			if (!occurrence.ok) return failed(occurrence.failure);
			out.push({
				kind: ch === "(" ? "parameter" : "typeParameter",
				name,
				...(occurrence.value === undefined ? {} : { occurrence: occurrence.value }),
			});
			continue;
		}

		const name = readName(c);
		if (name === null) return failed(c.fail("expected a descriptor name"));

		// The open paren is what separates a method from a term of the same name.
		if (c.peek() === "(") {
			c.next();
			// Charset-restricted rather than balanced, per parsing law rule 4.
			const disambiguator = c.takeWhile((x) => DISAMBIGUATOR_RE.test(x));
			if (c.peek() !== ")") return failed(c.fail("expected ) to close the disambiguator"));
			c.next();
			const occurrence = readOccurrence(c);
			if (!occurrence.ok) return failed(occurrence.failure);
			const carried = occurrence.value === undefined ? {} : { occurrence: occurrence.value };

			// A dot after the parens is the method form, so it cannot be read as a term suffix.
			if (c.peek() === ".") {
				c.next();
				out.push({ kind: "method", name, ...(disambiguator === "" ? {} : { disambiguator }), ...carried });
				continue;
			}

			const kind = SUFFIX_KIND.get(c.peek());
			if (kind === undefined) {
				return failed(c.fail(`expected a descriptor suffix, got ${JSON.stringify(c.peek())}`));
			}
			// Empty parens stay method-only, or one symbol would have two spellings.
			if (disambiguator === "") {
				return failed(c.fail("only a method descriptor may carry an empty disambiguator"));
			}
			c.next();
			out.push({ kind, name, disambiguator, ...carried });
			continue;
		}

		const occurrence = readOccurrence(c);
		if (!occurrence.ok) return failed(occurrence.failure);
		const kind = SUFFIX_KIND.get(c.peek());
		if (kind === undefined) {
			return failed(c.fail(`expected a descriptor suffix, got ${JSON.stringify(c.peek())}`));
		}
		c.next();
		out.push({ kind, name, ...(occurrence.value === undefined ? {} : { occurrence: occurrence.value }) });
	}

	if (out.length === 0) return { failure: c.fail("a symbol needs at least one descriptor"), rest: "" };
	return null;
}

/** Leaves the delimiter unconsumed, so a failure brackets the field and not the space after it. */
export function readIdField(c: Cursor, what: string): ParseResult<string> {
	c.mark();
	const field = c.takeWhile((ch) => ch !== " ");
	if (field === "") return err(c.fail(`expected ${what}`));
	return ok(field);
}

export function expectIdSpace(c: Cursor, after: string): ParseFailure | null {
	if (c.peek() !== " ") return c.fail(`expected a space after ${after}`);
	c.next();
	return null;
}

/** Scheme, language, module and the local form; leaves the cursor at the first descriptor. */
function parseHead(c: Cursor, text: string): ParseResult<IdHead> {
	const scheme = readIdField(c, "the scheme");
	if (!scheme.ok) return scheme;
	if (scheme.value !== SYMBOL_SCHEME) return err(c.fail(`expected scheme ${SYMBOL_SCHEME}`));
	const afterScheme = expectIdSpace(c, "the scheme");
	if (afterScheme) return err(afterScheme);

	const language = readIdField(c, "the language");
	if (!language.ok) return language;
	const afterLanguage = expectIdSpace(c, "the language");
	if (afterLanguage) return err(afterLanguage);

	const moduleField = readIdField(c, "the module");
	if (!moduleField.ok) return moduleField;

	const module = decodeModuleField(moduleField.value);
	// The parser must accept exactly what the composer emits, or an id becomes host-dependent.
	if (!isCanonicalModule(module)) return err(c.fail(`module is not in canonical form: ${module}`));

	const afterModule = expectIdSpace(c, "the module");
	if (afterModule) return err(afterModule);

	c.mark();
	if (c.peek() === "l") {
		const rest = text.slice(c.offset);
		const localMatch = /^local(\d+)$/.exec(rest);
		if (localMatch) {
			const digits = localMatch[1] as string;
			const local = safeDigits(digits);
			if (local === null) return err(c.fail(`local ordinal is not a safe integer: ${digits}`));
			return ok({ language: language.value, module, local });
		}
	}

	return ok({ language: language.value, module });
}

/** Canonical form, carrying a diagnosis. `parseSymbolId` is the null-returning shim over it. */
export function parseSymbolIdResult(text: string): ParseResult<SymbolId> {
	const c = new Cursor(text);
	const head = parseHead(c, text);
	if (!head.ok) return head;
	const { language, module, local } = head.value;
	if (local !== undefined) return ok({ language, module, descriptors: [], local });

	const descriptors: Descriptor[] = [];
	const failed = parseDescriptors(c, descriptors);
	if (failed !== null) return err(failed.failure);
	return ok({ language, module, descriptors });
}

/** The descriptors a malformed id parsed before it failed, and the text it did not. */
export function parseSymbolIdPrefix(text: string): SymbolIdPrefix {
	const c = new Cursor(text);
	const head = parseHead(c, text);
	if (!head.ok) return { descriptors: [], failure: head.failure, rest: "" };
	if (head.value.local !== undefined) return { descriptors: [], failure: null, rest: "" };

	const descriptors: Descriptor[] = [];
	const failed = parseDescriptors(c, descriptors);
	if (failed === null) return { descriptors, failure: null, rest: "" };
	return { descriptors, ...failed };
}

/** Whole tokens of unparsed descriptor text; a quoted name and a `(...)` span are one unit each. */
function tailTokens(rest: string): string[] {
	const c = new Cursor(rest);
	const tokens: string[] = [];
	while (c.good()) {
		const ch = c.peek();
		if (ch === "`") {
			const quoted = readName(c);
			if (quoted !== null) tokens.push(quoted);
			continue;
		}
		if (ch === "(") {
			c.takeWhile((x) => x !== ")");
			c.next();
			continue;
		}
		if (STRUCTURAL.has(ch)) {
			c.next();
			continue;
		}
		tokens.push(c.takeWhile((x) => !STRUCTURAL.has(x)));
	}
	return tokens;
}

/** Whether a bad id spells a name: a parsed descriptor carries it, or the unparsed rest holds it whole. */
export function spellsName(text: string): (name: string) => boolean {
	const prefix = parseSymbolIdPrefix(text);
	const names = new Set(prefix.descriptors.map((d) => d.name.normalize("NFC")));
	for (const token of tailTokens(prefix.rest)) names.add(token.normalize("NFC"));
	return (name) => names.has(name.normalize("NFC"));
}

/** Null rather than throwing: malformed ids arrive from providers and from disk. */
export function parseSymbolId(text: string): SymbolId | null {
	const result = parseSymbolIdResult(text);
	return result.ok ? result.value : null;
}

export function isSymbolId(text: string): boolean {
	return parseSymbolIdResult(text).ok;
}

export function isLocalSymbol(text: string): boolean {
	return parseSymbolId(text)?.local !== undefined;
}

/** The module an id belongs to, which is what per-file invalidation keys on. */
export function moduleOf(text: string): string | null {
	return parseSymbolId(text)?.module ?? null;
}

/**
 * The declaration this symbol belongs TO, by dropping its last descriptor.
 *
 * A parameter is owned by its function and a member by its type, and the id grammar already says so,
 * so this needs no store lookup and no language knowledge. Renaming an owned symbol can require
 * rewriting the OWNER's call sites, which are occurrences of a different name entirely.
 *
 * Null for a top-level symbol, which owns itself, and for a local, whose ordinal names no chain.
 */
export function ownerOf(text: string): string | null {
	const id = parseSymbolId(text);
	if (id === null || id.local !== undefined || id.descriptors.length < 2) return null;
	return composeSymbolId({ ...id, descriptors: id.descriptors.slice(0, -1) });
}

/** Whether this id names a parameter, which is the case whose rename reaches its owner's callers. */
export function isParameterSymbol(text: string): boolean {
	return parseSymbolId(text)?.descriptors.at(-1)?.kind === "parameter";
}

/** The same last descriptor, container name and language in another module, for a person to
 * read as a candidate; never a local, whose ordinal names no chain. */
export function sameNameAndKind(a: string, b: string): boolean {
	const left = parseSymbolId(a);
	const right = parseSymbolId(b);
	if (left === null || right === null) return false;
	if (left.local !== undefined || right.local !== undefined) return false;
	if (left.language !== right.language || left.module === right.module) return false;
	const last = left.descriptors.at(-1) as Descriptor;
	const other = right.descriptors.at(-1) as Descriptor;
	if (last.kind !== other.kind || last.name !== other.name) return false;
	if (!MEMBER_KINDS.has(last.kind)) return true;
	const container = left.descriptors.at(-2);
	const otherContainer = right.descriptors.at(-2);
	if (container === undefined || otherContainer === undefined) return container === otherContainer;
	return container.name === otherContainer.name;
}

/** Kinds that belong to their container, so the same name under another container is another thing. */
const MEMBER_KINDS = new Set<DescriptorKind>(["method", "parameter", "typeParameter", "term"]);

function sameDescriptor(a: Descriptor, b: Descriptor): boolean {
	return (
		a.kind === b.kind && a.name === b.name && a.disambiguator === b.disambiguator && a.occurrence === b.occurrence
	);
}

/**
 * Whether `text` is `ancestor` or something declared inside it.
 *
 * Structural, not a store lookup: a member's id already carries its container's descriptors, so
 * the chain answers this without asking anything about the code.
 */
export function isWithin(text: string, ancestor: string): boolean {
	const id = parseSymbolId(text);
	const root = parseSymbolId(ancestor);
	if (id === null || root === null) return false;
	if (id.local !== undefined || root.local !== undefined) return false;
	if (id.language !== root.language || id.module !== root.module) return false;
	if (id.descriptors.length < root.descriptors.length) return false;
	return root.descriptors.every((d, i) => sameDescriptor(d, id.descriptors[i] as Descriptor));
}

/**
 * Re-mint `text` for a container rename or a module move.
 *
 * Both operations change a declaration's id, and because descriptors chain, both change every id
 * beneath it: renaming a class re-mints its methods and their parameters. This is the single
 * owner of that rewrite, so no caller has to take a string apart to do it.
 *
 * Null when `text` is not `from` or inside it, and for locals, whose ordinal names no chain and so
 * cannot be traced to the declaration that held them.
 */
export function rebaseSymbolId(text: string, from: string, to: string): string | null {
	if (!isWithin(text, from)) return null;

	const id = parseSymbolId(text) as SymbolId;
	const oldRoot = parseSymbolId(from) as SymbolId;
	const newRoot = parseSymbolId(to);
	if (newRoot === null || newRoot.local !== undefined) return null;

	return composeSymbolId({
		language: newRoot.language,
		module: newRoot.module,
		descriptors: [...newRoot.descriptors, ...id.descriptors.slice(oldRoot.descriptors.length)],
	});
}
