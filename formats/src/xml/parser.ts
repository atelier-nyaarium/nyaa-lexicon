// XML 1.0 (Fifth Edition) by its grammar: one cursor, open elements on a stack, every token placed.
//
// Non-validating: the internal subset is read for its entity declarations, and nothing else in a
// document type is checked. The first well-formedness error ends the parse, as the spec requires.

import { type CursorMark, isTooDeep, NestingGauge, SourceCursor, TOO_DEEP } from "@nyaa-lexicon/protocol";
import {
	isNameCharacter,
	isNameStart,
	isPublicIdCharacter,
	isSpace,
	isXmlChar,
	type XmlAttribute,
	type XmlCdata,
	type XmlComment,
	type XmlDeclaration,
	type XmlDoctype,
	type XmlDocument,
	type XmlElement,
	type XmlInstruction,
	type XmlNode,
	type XmlParse,
	type XmlProblem,
	type XmlToken,
} from "./syntax.js";

////////////////////////////////
//  Interfaces & Types

/** Where a reference is replaced: attribute values normalize white space and refuse markup. */
type Context = "content" | "attribute";

interface Entity {
	/** Replacement text with character references replaced; absent for an external entity. */
	value?: string;
	/** Declared with `NDATA`, so no reference may name it. */
	unparsed?: boolean;
}

////////////////////////////////
//  Constants

const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff);

/** Expansion may write this many characters, plus the factor times the document's length. */
const EXPANSION_FLOOR = 1_000_000;
const EXPANSION_FACTOR = 10;

const PREDEFINED: ReadonlyMap<string, string> = new Map([
	["lt", "<"],
	["gt", ">"],
	["amp", "&"],
	["apos", "'"],
	["quot", '"'],
]);

////////////////////////////////
//  Functions & Helpers

function isDigit(character: string): boolean {
	return character.length === 1 && character >= "0" && character <= "9";
}

function isHexDigit(character: string): boolean {
	return isDigit(character) || (character >= "a" && character <= "f") || (character >= "A" && character <= "F");
}

function isLetter(character: string): boolean {
	return (character >= "a" && character <= "z") || (character >= "A" && character <= "Z");
}

function shown(character: string): string {
	return character === "" ? "the end of the text" : JSON.stringify(character);
}

/** Character data no rule stops at: not markup, a reference, a `]]>` candidate or a line break. */
function isPlainData(character: string): boolean {
	return character !== "<" && character !== "&" && character !== "]" && character !== "\r" && isXmlChar(character);
}

////////////////////////////////
//  Classes

class Refusal extends Error {
	constructor(readonly problem: XmlProblem) {
		super(problem.message);
	}
}

/** An entity's text holds markup, which content keeps as the reference written. */
class HoldsMarkup extends Error {}

class XmlParser {
	private readonly cursor: SourceCursor;
	private readonly tokens: XmlToken[] = [];
	private readonly entities = new Map<string, Entity>();
	private readonly gauge = new NestingGauge();
	/** No external subset or parameter entity may declare what the internal subset does not. */
	private declarationsComplete = true;
	/** Past an unread parameter entity, which may redeclare, later declarations are not processed. */
	private declarationsStopped = false;
	private standalone = false;
	/** Where the outermost reference being expanded starts. */
	private expandingFrom = 0;
	/** Characters entity expansion may still write, so a nested definition cannot explode. */
	private expansionBudget: number;

	constructor(text: string) {
		this.cursor = new SourceCursor(text);
		this.expansionBudget = EXPANSION_FLOOR + EXPANSION_FACTOR * text.length;
	}

	document(): XmlDocument {
		const children: XmlNode[] = [];
		// A byte order mark is an encoding signature, no character of the document.
		this.cursor.take(BYTE_ORDER_MARK);
		const declaration = this.xmlDeclaration();
		if (declaration !== undefined) children.push(declaration);
		this.misc(children);
		if (this.cursor.startsWith("<!DOCTYPE")) {
			children.push(this.doctype());
			this.misc(children);
		}
		if (this.cursor.peek() !== "<" || !isNameStart(this.cursor.peek(1)))
			this.fail("the document has no root element");
		const root = this.element();
		children.push(root);
		this.misc(children);
		if (this.cursor.good()) this.fail(`unexpected ${shown(this.cursor.peek())} after the root element`);
		return { children, root, tokens: this.tokens };
	}

	////////////////////////////////
	//  Reading

	private fail(message: string, pos = this.cursor.offset): never {
		throw new Refusal({ message, pos });
	}

	/** Where a failure at `cursor` sits in the source; in replacement text, the reference expanding it. */
	private sourceAt(cursor: SourceCursor): number {
		return cursor === this.cursor ? cursor.offset : this.expandingFrom;
	}

	private place(kind: XmlToken["kind"], start: CursorMark, end: number): void {
		if (end > start.offset)
			this.tokens.push({ kind, pos: start.offset, end, line: start.line, column: start.column });
	}

	/** Throws unless the loop at `guard` moved the cursor; answers where it now stands. */
	private advanced(guard: number, what: string): number {
		if (this.cursor.offset <= guard) throw new Error(`xml ${what} scan failed to advance`);
		return this.cursor.offset;
	}

	private space(): boolean {
		return this.cursor.readWhile(isSpace) !== "";
	}

	private requireSpace(what: string): void {
		if (!this.space()) this.fail(`${what} needs white space here`);
	}

	private name(cursor = this.cursor): string {
		if (!isNameStart(cursor.peek())) return "";
		return cursor.next() + cursor.readWhile(isNameCharacter);
	}

	/** One character, which must be an XML `Char`. */
	private character(): string {
		const pos = this.cursor.offset;
		const character = this.cursor.next();
		if (!isXmlChar(character)) {
			const point = (character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
			this.fail(`U+${point} is not an XML character`, pos);
		}
		return character;
	}

	/** One character with its line break normalized: CR LF and a lone CR each read as LF. */
	private normalized(): string {
		const character = this.character();
		if (character !== "\r") return character;
		if (this.cursor.peek() === "\n") this.cursor.next();
		return "\n";
	}

	/** A quoted literal's text, read past its closing quote. */
	private quoted(what: string, accepts: (character: string) => boolean = isXmlChar): string {
		const pos = this.cursor.offset;
		const quote = this.cursor.peek();
		if (quote !== '"' && quote !== "'") this.fail(`${what} must be quoted`);
		this.cursor.next();
		let value = "";
		let guard = -1;
		while (!this.cursor.take(quote)) {
			guard = this.advanced(guard, "literal");
			if (!this.cursor.good()) this.fail(`${what} has no closing quote`, pos);
			if (!accepts(this.cursor.peek())) this.fail(`${shown(this.cursor.peek())} may not appear in ${what}`);
			value += this.character();
		}
		return value;
	}

	private equals(): void {
		this.space();
		if (!this.cursor.take("=")) this.fail(`expected = but found ${shown(this.cursor.peek())}`);
		this.space();
	}

	////////////////////////////////
	//  Prolog

	private xmlDeclaration(): XmlDeclaration | undefined {
		if (!this.cursor.startsWith("<?xml") || isNameCharacter(this.cursor.peek(5))) return undefined;
		const start = this.cursor.mark();
		const pos = start.offset;
		this.cursor.take("<?xml");
		this.requireSpace("<?xml");
		if (!this.cursor.take("version")) this.fail("the XML declaration has no version");
		this.equals();
		const version = this.quoted("the version");
		if (!version.startsWith("1.") || version.length < 3 || [...version.slice(2)].some((c) => !isDigit(c)))
			this.fail(`${JSON.stringify(version)} is no XML 1.x version`, pos);
		let spaced = this.space();
		if (spaced && this.cursor.take("encoding")) {
			this.equals();
			const [first = "", ...rest] = [...this.quoted("the encoding")];
			if (
				!isLetter(first) ||
				rest.some((c) => !isLetter(c) && !isDigit(c) && c !== "." && c !== "_" && c !== "-")
			)
				this.fail("the encoding name holds a character no encoding name may", pos);
			spaced = this.space();
		}
		let standalone: boolean | undefined;
		if (spaced && this.cursor.take("standalone")) {
			this.equals();
			const value = this.quoted("standalone");
			if (value !== "yes" && value !== "no") this.fail("standalone must be yes or no", pos);
			standalone = value === "yes";
			this.standalone = standalone;
			this.space();
		}
		if (!this.cursor.take("?>")) this.fail("the XML declaration does not end at ?>", pos);
		this.place("markup", start, this.cursor.offset);
		return { type: "declaration", pos, end: this.cursor.offset, standalone };
	}

	/** Comments, instructions and white space. */
	private misc(children: XmlNode[]): void {
		let guard = -1;
		for (;;) {
			if (this.cursor.offset <= guard) throw new Error("xml misc scan failed to advance");
			guard = this.cursor.offset;
			this.space();
			if (this.cursor.startsWith("<!--")) children.push(this.comment());
			else if (this.cursor.startsWith("<?")) children.push(this.instruction());
			else return;
		}
	}

	private comment(): XmlComment {
		const start = this.cursor.mark();
		const pos = start.offset;
		this.cursor.take("<!--");
		let guard = -1;
		while (!this.cursor.take("-->")) {
			guard = this.advanced(guard, "comment");
			if (this.cursor.startsWith("--")) this.fail("a comment may not hold --");
			if (!this.cursor.good()) this.fail("the comment has no -->", pos);
			if (this.cursor.peek() === "-") this.cursor.next();
			// Nothing read means a character XML does not allow.
			else if (this.cursor.readWhile((character) => character !== "-" && isXmlChar(character)) === "")
				this.character();
		}
		this.place("comment", start, this.cursor.offset);
		return { type: "comment", pos, end: this.cursor.offset };
	}

	private instruction(): XmlInstruction {
		const start = this.cursor.mark();
		const pos = start.offset;
		this.cursor.take("<?");
		const target = this.name();
		if (target === "") this.fail("the processing instruction has no target");
		if (target.toLowerCase() === "xml") this.fail("<?xml may only start the document", pos);
		if (!this.cursor.take("?>")) {
			this.requireSpace(`<?${target}`);
			let guard = -1;
			while (!this.cursor.take("?>")) {
				guard = this.advanced(guard, "instruction");
				if (!this.cursor.good()) this.fail(`<?${target} has no ?>`, pos);
				this.character();
			}
		}
		this.place("markup", start, this.cursor.offset);
		return { type: "instruction", pos, end: this.cursor.offset, target };
	}

	////////////////////////////////
	//  Document type

	private doctype(): XmlDoctype {
		const start = this.cursor.mark();
		const pos = start.offset;
		this.cursor.take("<!DOCTYPE");
		this.requireSpace("<!DOCTYPE");
		const name = this.name();
		if (name === "") this.fail("the document type has no name");
		if (this.space() && (this.cursor.startsWith("SYSTEM") || this.cursor.startsWith("PUBLIC"))) {
			this.externalId();
			this.declarationsComplete = false;
			this.space();
		}
		let closing = start;
		if (this.cursor.take("[")) {
			this.place("markup", start, this.cursor.offset);
			this.internalSubset();
			closing = this.cursor.mark();
			this.cursor.next();
			this.space();
		}
		if (!this.cursor.take(">")) this.fail("the document type does not end at >", pos);
		this.place("markup", closing, this.cursor.offset);
		return { type: "doctype", pos, end: this.cursor.offset, name };
	}

	private externalId(): void {
		if (this.cursor.take("SYSTEM")) {
			this.requireSpace("SYSTEM");
			this.quoted("the system identifier");
			return;
		}
		this.cursor.take("PUBLIC");
		this.requireSpace("PUBLIC");
		this.quoted("the public identifier", isPublicIdCharacter);
		this.requireSpace("the public identifier");
		this.quoted("the system identifier");
	}

	/** Declarations up to the `]` closing the subset, which is left unread. */
	private internalSubset(): void {
		let guard = -1;
		for (;;) {
			if (this.cursor.offset <= guard) throw new Error("xml internal subset scan failed to advance");
			guard = this.cursor.offset;
			this.space();
			const start = this.cursor.mark();
			const pos = start.offset;
			if (this.cursor.peek() === "]") return;
			if (!this.cursor.good()) this.fail("the internal subset has no ]");
			if (this.cursor.startsWith("<!--")) this.comment();
			else if (this.cursor.startsWith("<?")) this.instruction();
			else if (this.cursor.startsWith("<!ENTITY")) this.entityDeclaration();
			else if (["<!ELEMENT", "<!ATTLIST", "<!NOTATION"].some((opener) => this.cursor.startsWith(opener)))
				this.markupDeclaration();
			else if (this.cursor.take("%")) {
				if (this.name() === "" || !this.cursor.take(";"))
					this.fail("% must start a parameter entity reference", pos);
				this.declarationsComplete = false;
				// A standalone document declares nothing elsewhere, so its later declarations still count.
				this.declarationsStopped = !this.standalone;
				this.place("markup", start, this.cursor.offset);
			} else this.fail(`unexpected ${shown(this.cursor.peek())} in the internal subset`);
		}
	}

	private entityDeclaration(): void {
		const start = this.cursor.mark();
		const pos = start.offset;
		this.cursor.take("<!ENTITY");
		this.requireSpace("<!ENTITY");
		const parameter = this.cursor.take("%");
		if (parameter) this.requireSpace("%");
		const name = this.name();
		if (name === "") this.fail("the entity declaration has no name");
		this.requireSpace(`the entity ${name}`);
		let entity: Entity = {};
		const quote = this.cursor.peek();
		if (quote === '"' || quote === "'") entity = { value: this.entityValue(name) };
		else if (this.cursor.startsWith("SYSTEM") || this.cursor.startsWith("PUBLIC")) {
			this.externalId();
			if (this.space() && this.cursor.take("NDATA")) {
				if (parameter) this.fail(`the parameter entity ${name} may not be unparsed`);
				this.requireSpace("NDATA");
				if (this.name() === "") this.fail("NDATA names no notation");
				entity = { unparsed: true };
			}
		} else this.fail(`the entity ${name} needs a quoted value or an external identifier`);
		this.space();
		if (!this.cursor.take(">")) this.fail(`the entity declaration ${name} does not end at >`, pos);
		this.place("markup", start, this.cursor.offset);
		// The first declaration binds.
		if (!parameter && !this.declarationsStopped && !this.entities.has(name)) this.entities.set(name, entity);
	}

	/** Character references replaced now; entity references kept for their use. */
	private entityValue(name: string): string {
		const pos = this.cursor.offset;
		const quote = this.cursor.next();
		let value = "";
		let guard = -1;
		while (!this.cursor.take(quote)) {
			guard = this.advanced(guard, "entity value");
			if (!this.cursor.good()) this.fail(`the value of the entity ${name} has no closing quote`, pos);
			const character = this.cursor.peek();
			if (character === "%") this.fail("a parameter entity reference may not appear in a declaration here");
			if (character !== "&") value += this.normalized();
			else if (this.cursor.peek(1) === "#") value += this.characterReference(this.cursor);
			else {
				const at = this.cursor.offset;
				this.cursor.next();
				const referenced = this.name();
				if (referenced === "" || !this.cursor.take(";")) this.fail("& must start a reference ending in ;", at);
				value += `&${referenced};`;
			}
		}
		return value;
	}

	/** `<!ELEMENT`, `<!ATTLIST` and `<!NOTATION`, read to their `>` and not checked. */
	private markupDeclaration(): void {
		const start = this.cursor.mark();
		let guard = -1;
		while (!this.cursor.take(">")) {
			guard = this.advanced(guard, "declaration");
			if (!this.cursor.good()) this.fail("the declaration has no >", start.offset);
			const character = this.cursor.peek();
			if (character === '"' || character === "'") this.quoted("a literal");
			else this.character();
		}
		this.place("markup", start, this.cursor.offset);
	}

	////////////////////////////////
	//  Elements

	/** The root and everything in it, open elements on a stack rather than the call stack. */
	private element(): XmlElement {
		const root = this.startTag();
		if (root.empty) return root.element;
		const open: XmlElement[] = [root.element];
		let guard = -1;
		while (open.length > 0) {
			if (this.cursor.offset <= guard) throw new Error("xml content scan failed to advance");
			guard = this.cursor.offset;
			const current = open[open.length - 1] as XmlElement;
			if (this.cursor.startsWith("</")) {
				this.endTag(current);
				open.pop();
				this.gauge.close();
			} else if (this.cursor.startsWith("<!--")) current.children.push(this.comment());
			else if (this.cursor.startsWith("<![CDATA[")) current.children.push(this.cdata());
			else if (this.cursor.startsWith("<?")) current.children.push(this.instruction());
			else if (this.cursor.peek() === "<") {
				const child = this.startTag();
				current.children.push(child.element);
				if (!child.empty) open.push(child.element);
			} else if (this.cursor.good()) this.characterData(current);
			else this.fail(`<${current.name}> has no end tag`, current.pos);
		}
		return root.element;
	}

	private startTag(): { element: XmlElement; empty: boolean } {
		const start = this.cursor.mark();
		const pos = start.offset;
		this.cursor.next();
		const name = this.name();
		if (name === "") this.fail("< must start a tag; write &lt; for a literal <", pos);
		try {
			this.gauge.open();
		} catch (error) {
			if (isTooDeep(error)) this.fail(TOO_DEEP, pos);
			throw error;
		}
		const attributes: XmlAttribute[] = [];
		let empty = false;
		let guard = -1;
		for (;;) {
			guard = this.advanced(guard, "start tag");
			const spaced = this.space();
			if (this.cursor.take("/>")) {
				empty = true;
				break;
			}
			if (this.cursor.take(">")) break;
			if (!this.cursor.good()) this.fail(`the start tag <${name}> has no >`, pos);
			if (!spaced || !isNameStart(this.cursor.peek()))
				this.fail(`unexpected ${shown(this.cursor.peek())} in the start tag <${name}>`);
			attributes.push(this.attribute(attributes));
		}
		if (empty) this.gauge.close();
		const end = this.cursor.offset;
		this.place("markup", start, end);
		const element: XmlElement = {
			type: "element",
			pos,
			end,
			name,
			attributes,
			startTagEnd: end,
			endTagPos: end,
			children: [],
		};
		return { element, empty };
	}

	private attribute(seen: readonly XmlAttribute[]): XmlAttribute {
		const pos = this.cursor.offset;
		const name = this.name();
		const nameEnd = this.cursor.offset;
		if (seen.some((attribute) => attribute.name === name)) this.fail(`the attribute ${name} is given twice`, pos);
		this.equals();
		const valuePos = this.cursor.offset;
		const quote = this.cursor.peek();
		if (quote !== '"' && quote !== "'") this.fail(`the value of ${name} must be quoted`);
		this.cursor.next();
		const plain = (character: string): boolean =>
			character !== quote &&
			character !== "<" &&
			character !== "&" &&
			!isSpace(character) &&
			isXmlChar(character);
		let value = "";
		let guard = -1;
		while (!this.cursor.take(quote)) {
			guard = this.advanced(guard, "attribute value");
			if (!this.cursor.good()) this.fail(`the value of ${name} has no closing quote`, valuePos);
			value += this.cursor.readWhile(plain);
			const character = this.cursor.peek();
			if (character === quote || character === "") continue;
			if (character === "<") this.fail(`the value of ${name} may not hold <; write &lt;`);
			if (character === "&") {
				const mark = this.cursor.mark();
				value += this.reference(this.cursor, "attribute", []) ?? this.cursor.textSince(mark);
			} else if (isSpace(character)) {
				this.normalized();
				value += " ";
			} else this.character();
		}
		return { name, pos, end: this.cursor.offset, nameEnd, value, valuePos };
	}

	private endTag(current: XmlElement): void {
		const start = this.cursor.mark();
		const pos = start.offset;
		this.cursor.take("</");
		const name = this.name();
		if (name !== current.name) this.fail(`</${name}> does not close <${current.name}>`, pos);
		this.space();
		if (!this.cursor.take(">")) this.fail(`the end tag </${name}> does not end at >`, pos);
		this.place("markup", start, this.cursor.offset);
		current.endTagPos = pos;
		current.end = this.cursor.offset;
	}

	private cdata(): XmlCdata {
		const start = this.cursor.mark();
		const pos = start.offset;
		this.cursor.take("<![CDATA[");
		let text = "";
		let guard = -1;
		while (!this.cursor.take("]]>")) {
			guard = this.advanced(guard, "CDATA");
			if (!this.cursor.good()) this.fail("the CDATA section has no ]]>", pos);
			text += this.cursor.readWhile(
				(character) => character !== "]" && character !== "\r" && isXmlChar(character),
			);
			if (this.cursor.good() && !this.cursor.startsWith("]]>")) text += this.normalized();
		}
		this.place("cdata", start, this.cursor.offset);
		return { type: "cdata", pos, end: this.cursor.offset, text };
	}

	/** Characters and references up to the next tag, as one text node. */
	private characterData(parent: XmlElement): void {
		const start = this.cursor.mark();
		const pos = start.offset;
		let text = "";
		let guard = -1;
		while (this.cursor.good()) {
			if (this.cursor.offset <= guard) throw new Error("xml character data scan failed to advance");
			guard = this.cursor.offset;
			text += this.cursor.readWhile(isPlainData);
			const character = this.cursor.peek();
			if (character === "" || character === "<") break;
			if (character === "&") {
				const mark = this.cursor.mark();
				text += this.reference(this.cursor, "content", []) ?? this.cursor.textSince(mark);
			} else if (this.cursor.startsWith("]]>")) this.fail("]]> may not appear in character data");
			else text += this.normalized();
		}
		this.place("text", start, this.cursor.offset);
		parent.children.push({ type: "text", pos, end: this.cursor.offset, text });
	}

	////////////////////////////////
	//  References

	/**
	 * The text a reference at `cursor` stands for; undefined when it stays as written: an external
	 * entity, one an unread declaration may define, or one whose text holds markup.
	 */
	private reference(cursor: SourceCursor, context: Context, expanding: readonly string[]): string | undefined {
		if (cursor.peek(1) === "#") return this.characterReference(cursor);
		const at = this.sourceAt(cursor);
		cursor.next();
		const name = this.name(cursor);
		if (name === "" || !cursor.take(";"))
			this.fail("& must start a reference ending in ;; write &amp; for a literal &", at);
		const predefined = PREDEFINED.get(name);
		if (predefined !== undefined) return predefined;
		const entity = this.entities.get(name);
		if (entity === undefined) {
			if (this.declarationsComplete || this.standalone) this.fail(`the entity &${name}; is not declared`, at);
			return undefined;
		}
		if (entity.unparsed === true) this.fail(`the unparsed entity ${name} may not be referenced`, at);
		if (entity.value === undefined) {
			if (context === "attribute")
				this.fail(`an attribute value may not reference the external entity ${name}`, at);
			return undefined;
		}
		if (expanding.includes(name)) this.fail(`the entity ${name} refers to itself`, at);
		const value = entity.value;
		const expand = (): string => {
			try {
				this.gauge.open();
			} catch (error) {
				if (isTooDeep(error)) this.fail(TOO_DEEP, this.expandingFrom);
				throw error;
			}
			try {
				return this.replacement(value, context, [...expanding, name]);
			} finally {
				this.gauge.close();
			}
		};
		if (expanding.length > 0) return expand();
		this.expandingFrom = at;
		try {
			return expand();
		} catch (error) {
			if (error instanceof HoldsMarkup) return undefined;
			throw error;
		}
	}

	private spend(characters: number): void {
		this.expansionBudget -= characters;
		if (this.expansionBudget < 0)
			this.fail("entity expansion writes more text than the document allows", this.expandingFrom);
	}

	/** An entity's replacement text with its own references replaced. */
	private replacement(value: string, context: Context, expanding: readonly string[]): string {
		const cursor = new SourceCursor(value);
		let text = "";
		let guard = -1;
		while (cursor.good()) {
			if (cursor.offset <= guard) throw new Error("xml entity expansion failed to advance");
			guard = cursor.offset;
			const character = cursor.peek();
			if (character === "<") {
				if (context === "attribute") this.fail(`the entity ${expanding.at(-1)} puts < in an attribute value`);
				throw new HoldsMarkup();
			}
			if (character === "&") {
				const mark = cursor.mark();
				const written = this.reference(cursor, context, expanding) ?? cursor.textSince(mark);
				this.spend(written.length);
				text += written;
				continue;
			}
			if (context === "content" && cursor.startsWith("]]>"))
				this.fail("]]> may not appear in character data", this.expandingFrom);
			cursor.next();
			this.spend(character.length);
			text += context === "attribute" && isSpace(character) ? " " : character;
		}
		return text;
	}

	private characterReference(cursor: SourceCursor): string {
		const at = this.sourceAt(cursor);
		cursor.take("&#");
		const hex = cursor.take("x");
		const digits = cursor.readWhile(hex ? isHexDigit : isDigit);
		if (digits === "" || !cursor.take(";")) this.fail("a character reference needs digits and ;", at);
		const point = Number.parseInt(digits, hex ? 16 : 10);
		const character = point <= 0x10ffff ? String.fromCodePoint(point) : "";
		if (!isXmlChar(character)) this.fail(`&#${hex ? "x" : ""}${digits}; is not an XML character`, at);
		return character;
	}
}

////////////////////////////////
//  Main

/** Nothing but a byte order mark and white space: no document, and no error either. */
export function isBlankDocument(text: string): boolean {
	const cursor = new SourceCursor(text);
	cursor.take(BYTE_ORDER_MARK);
	cursor.readWhile(isSpace);
	return !cursor.good();
}

/** The document, or the first well-formedness error. */
export function parseXmlDocument(text: string): XmlParse {
	try {
		return { document: new XmlParser(text).document() };
	} catch (error) {
		if (error instanceof Refusal) return { problem: error.problem };
		throw error;
	}
}
