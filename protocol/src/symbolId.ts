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
	/** Arity or overload index, distinguishing two same-named methods. */
	disambiguator?: string;
}

export interface SymbolId {
	language: string;
	module: string;
	descriptors: Descriptor[];
	/** Ordinal for a function-scoped symbol, since two locals may share a name. */
	local?: number;
}

////////////////////////////////
//  Constants

export const SYMBOL_SCHEME = "lexicon";

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
	// Encodable whitespace is only the space; a tab or newline in a path is pathological.
	if (/[\t\n\r\v\f\0]/.test(forward)) {
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

/** Quote only when bare parsing would break. Embedded backticks double, as in SCIP. */
export function quoteName(name: string): string {
	if (name === "") throw new Error("a descriptor name cannot be empty");
	const nfc = name.normalize("NFC");
	for (const ch of nfc) {
		if (STRUCTURAL.has(ch)) return `\`${nfc.replace(/`/g, "``")}\``;
	}
	return nfc;
}

function encodeDescriptor(d: Descriptor): string {
	const name = quoteName(d.name);
	if (d.kind === "method") {
		if (d.disambiguator !== undefined && !DISAMBIGUATOR_RE.test(d.disambiguator)) {
			throw new Error(`disambiguator must match ${DISAMBIGUATOR_RE}, got: ${JSON.stringify(d.disambiguator)}`);
		}
		return `${name}(${d.disambiguator ?? ""}).`;
	}

	// Refused rather than ignored: only a method has a slot to render one, so dropping it would
	// silently collapse two symbols the caller meant to keep apart onto one id.
	if (d.disambiguator !== undefined) {
		throw new Error(`only a method descriptor can carry a disambiguator, got kind: ${d.kind}`);
	}

	if (d.kind === "parameter") return `(${name})`;
	if (d.kind === "typeParameter") return `[${name}]`;
	return `${name}${KIND_SUFFIX[d.kind]}`;
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

/**
 * Token stage collapsed on purpose, per docs/parsing.md rule 2: the grammar is non-recursive and
 * the input is machine-generated, so a token type would carry no information the caller can use.
 */
function parseDescriptors(c: Cursor): ParseResult<Descriptor[]> {
	const out: Descriptor[] = [];
	let guard = -1;

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
			if (name === null) return err(c.fail("expected a parameter name"));
			if (c.peek() !== close) return err(c.fail(`expected ${close} to close the parameter`));
			c.next();
			out.push({ kind: ch === "(" ? "parameter" : "typeParameter", name });
			continue;
		}

		const name = readName(c);
		if (name === null) return err(c.fail("expected a descriptor name"));

		// The open paren is what separates a method from a term of the same name.
		if (c.peek() === "(") {
			c.next();
			// Charset-restricted rather than balanced, per parsing law rule 4.
			const disambiguator = c.takeWhile((x) => DISAMBIGUATOR_RE.test(x));
			if (c.peek() !== ")") return err(c.fail("expected ) to close the method disambiguator"));
			c.next();
			if (c.peek() !== ".") return err(c.fail("expected . after a method descriptor"));
			c.next();
			out.push(disambiguator === "" ? { kind: "method", name } : { kind: "method", name, disambiguator });
			continue;
		}

		const kind = SUFFIX_KIND.get(c.peek());
		if (kind === undefined) return err(c.fail(`expected a descriptor suffix, got ${JSON.stringify(c.peek())}`));
		c.next();
		out.push({ kind, name });
	}

	if (out.length === 0) return err(c.fail("a symbol needs at least one descriptor"));
	return ok(out);
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

/** Canonical form, carrying a diagnosis. `parseSymbolId` is the null-returning shim over it. */
export function parseSymbolIdResult(text: string): ParseResult<SymbolId> {
	const c = new Cursor(text);

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
			return ok({ language: language.value, module, descriptors: [], local });
		}
	}

	const descriptors = parseDescriptors(c);
	if (!descriptors.ok) return descriptors;
	return ok({ language: language.value, module, descriptors: descriptors.value });
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

function sameDescriptor(a: Descriptor, b: Descriptor): boolean {
	return a.kind === b.kind && a.name === b.name && a.disambiguator === b.disambiguator;
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
