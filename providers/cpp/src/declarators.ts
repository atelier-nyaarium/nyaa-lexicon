// What a declaration's tokens say, read without declaring: prefixes, heads, declarators and specifiers.

import { bracketDelta } from "./angles.js";
import type { TokenSpan } from "./header.js";
import type { Prefix, TemplateInfo, TemplateParameter } from "./model.js";
import { CppTokenStream } from "./tokenStream.js";
import type { Token } from "./tokens.js";
import { isSignificant } from "./tokens.js";
import { joinTokens, matching, significantAfter, significantBefore, statementEnd, tokenAt } from "./tokenWalk.js";
import {
	CONTROL_NAMES,
	DECLARATION_OPENERS,
	DECLARATION_SPECIFIERS,
	FUNDAMENTAL_TYPES,
	isNameToken,
	isShoutCase,
	KEYWORDS,
	MODIFIERS,
	SPECIFIER_WORDS,
} from "./words.js";

////////////////////////////////
//  Interfaces & Types

export interface FunctionTail {
	/** The body's `{`, or -1. */
	body: number;
	/** The body's `{`, or the token ending the declaration. */
	end: number;
	/** `try` before the body, so handlers follow it. */
	tryBlock: boolean;
}

export interface FunctionName {
	name: string;
	nameStartIndex: number;
	nameEndIndex: number;
	qualifier: string[];
	qualifierStart: number;
	/** Qualifier names written with template arguments, `B<T>::`, each taking one of the template heads. */
	templatedQualifiers: number;
}

/** One declarator's tokens. */
export interface DeclaratorSite {
	/** First token: a pointer operator, a nested declarator's `(`, the qualifier or the name. */
	start: number;
	name: number;
	/** First token of the qualifier written before the name, or the name. */
	qualifierStart: number;
	/** The `(` right after the name, or -1. */
	call: number;
	/** The `)` closing a nested declarator, or -1. */
	nested: number;
	/** Where an initializer, a bit-field width or the segment's end begins. */
	end: number;
}

/** What a declaration's specifiers hold. */
export interface SpecifierShape {
	/** Only words, names, `::`, template arguments, attributes and `decltype(...)`. */
	clean: boolean;
	/** A name, a fundamental type word, `auto` or `decltype`. */
	typed: boolean;
	/** A word no expression starts with. */
	keyworded: boolean;
	/** A `::` or template arguments. */
	compound: boolean;
	firstName?: string;
}

/** A class or enum head. */
export interface ClassHead {
	/** The name, or -1 when unnamed. */
	name: number;
	/** First token of a qualifier written before the name, or the name. */
	qualifierStart: number;
	/** The body's `{`, or -1. */
	body: number;
	/** The `;` ending a declaration without a body, or -1. */
	end: number;
	/** The `:` opening bases or an underlying type, or -1. */
	bases: number;
	/** Macro words before the name. */
	macros: number[];
}

////////////////////////////////
//  Constants

/** What ends a declarator's name: an initializer, a parameter list, an array bound, a bit-field width. */
const DECLARATOR_STOPS: ReadonlySet<string> = new Set(["=", "{", "(", "[", ":", ";", ","]);

/** What ends a nested declarator's suffixes. */
const DECLARATOR_ENDS: ReadonlySet<string> = new Set(["=", "{", ":", ";", ","]);

/** What may follow a function declarator's parameter list, so the call before it is one. */
const DECLARATOR_CONTINUATIONS: ReadonlySet<string> = new Set([
	"{",
	":",
	"=",
	"->",
	"const",
	"volatile",
	"noexcept",
	"throw",
	"override",
	"final",
	"requires",
	"try",
	"&",
	"&&",
	"(",
]);

/** Punctuation a declarator holds before its stop; any other makes an expression. */
const DECLARATOR_PUNCTUATION: ReadonlySet<string> = new Set(["::", "*", "&", "&&", "..."]);

////////////////////////////////
//  Functions & Helpers

export function isAssignment(value: string): boolean {
	return value === "=";
}

////////////////////////////////
//  Classes

export class CppDeclaratorReader extends CppTokenStream {
	/** A macro alone on its line, ahead of a directive, a macro call or a word no type precedes. */
	protected isStandaloneMacroPrefix(
		index: number,
		next: number,
		nextToken: Token | undefined,
		limit: number,
	): boolean {
		const token = tokenAt(this.tokens, index);
		const previous = significantBefore(this.tokens, index);
		if (token === undefined || (previous >= 0 && tokenAt(this.tokens, previous)?.end.line === token.start.line))
			return false;
		if (next < 0 || nextToken === undefined || nextToken.start.line <= token.start.line) return false;
		let candidate = next;
		while (candidate >= 0) {
			const candidateToken = tokenAt(this.tokens, candidate);
			if (candidateToken?.text === "#") return true;
			if (candidateToken?.kind === "identifier" && DECLARATION_OPENERS.has(candidateToken.value)) return true;
			if (candidateToken?.kind !== "identifier" || !isShoutCase(candidateToken.value)) return false;
			if (this.macroInvocationEnd(candidate, limit) >= 0) return true;
			// Every bare prefix in the chain is alone on its line too.
			const following = significantAfter(this.tokens, candidate, limit);
			if (following < 0 || (tokenAt(this.tokens, following)?.start.line ?? -1) <= candidateToken.start.line)
				return false;
			candidate = following;
		}
		return false;
	}

	/**
	 * Past a macro call standing alone as a statement, or -1. A declaration after it on its line takes
	 * it as an attribute instead. A call whose name is not SHOUT_CASE stands alone only before a later
	 * line's declaration, as `declare()` then `int real;`; otherwise it is a function's declarator.
	 */
	protected macroInvocationEnd(startIndex: number, limit: number): number {
		const name = tokenAt(this.tokens, startIndex);
		if (name?.kind !== "identifier" || KEYWORDS.has(name.value)) return -1;
		if (this.declarationSpecifierEnd(startIndex, limit) !== undefined) return -1;
		const open = significantAfter(this.tokens, startIndex, limit);
		if (tokenAt(this.tokens, open)?.text !== "(") return -1;
		const close = matching(this.tokens, open, "(", ")", limit);
		if (close < 0) return -1;
		const next = significantAfter(this.tokens, close, limit);
		const nextToken = tokenAt(this.tokens, next);
		const nextValue = nextToken?.text;
		if (nextValue !== undefined && DECLARATOR_CONTINUATIONS.has(nextValue)) return -1;
		const closeLine = tokenAt(this.tokens, close)?.end.line ?? -1;
		const sameLine = nextToken !== undefined && nextToken.start.line <= closeLine;
		if (sameLine && nextToken.kind === "identifier") return -1;
		if (!isShoutCase(name.value) && (sameLine || nextValue === ";" || nextToken === undefined)) return -1;
		if (nextValue === ".") return statementEnd(this.tokens, close + 1, limit) + 1;
		return nextValue === ";" ? next + 1 : close + 1;
	}

	protected readPrefix(startIndex: number, limit: number): Prefix | null {
		let index = startIndex;
		const heads: TemplateInfo[] = [];
		let explicitInstantiation = false;
		while (tokenAt(this.tokens, index)?.text === "template" && !explicitInstantiation) {
			const open = significantAfter(this.tokens, index, limit);
			if (tokenAt(this.tokens, open)?.text === "<") {
				const close = this.angleClose(open, limit);
				if (close <= open) {
					this.addDiagnostic("Template parameter list is not closed.", open);
					return null;
				}
				heads.push(this.templateInfo(open, close, index));
				index = significantAfter(this.tokens, close, limit);
				if (index < 0) return null;
			} else if (open >= 0 && heads.length === 0) {
				explicitInstantiation = true;
				index = open;
			} else {
				this.addDiagnostic("Template declaration needs a declaration.", index);
				return null;
			}
		}
		const template = heads.at(-1) ?? null;
		const modifiers = new Set<string>();
		let exported = false;
		let guard = -1;
		while (index >= 0 && index < limit) {
			if (index <= guard) throw new Error("declaration prefix failed to advance");
			guard = index;
			const token = tokenAt(this.tokens, index);
			const specifierEnd = this.declarationSpecifierEnd(index, limit);
			if (specifierEnd !== undefined) {
				if (specifierEnd < 0) return null;
				for (let consumed = index; consumed < specifierEnd; consumed++) {
					this.declarationSpecifierTokenIndexes.add(consumed);
					if (tokenAt(this.tokens, consumed)?.kind === "identifier") this.excludedTokenIndexes.add(consumed);
				}
				index = significantAfter(this.tokens, specifierEnd - 1, limit);
				continue;
			}
			if (token?.kind === "string" && modifiers.has("extern")) {
				index = significantAfter(this.tokens, index, limit);
				continue;
			}
			const macroEnd = this.attributeMacroEnd(index, limit);
			if (macroEnd > index) {
				for (let consumed = index; consumed < macroEnd; consumed++) {
					this.declarationSpecifierTokenIndexes.add(consumed);
					if (tokenAt(this.tokens, consumed)?.kind === "identifier") this.excludedTokenIndexes.add(consumed);
				}
				index = this.codeAfter(macroEnd - 1, limit);
				continue;
			}
			if (token?.text === "export") exported = true;
			if (token === undefined || !MODIFIERS.has(token.text)) break;
			modifiers.add(token.text);
			index = significantAfter(this.tokens, index, limit);
		}
		if (index < 0 || tokenAt(this.tokens, index) === undefined) return null;
		return { startIndex, keywordIndex: index, template, heads, explicitInstantiation, modifiers, exported };
	}

	/**
	 * Past a macro standing for an attribute inside a declaration's prefix: `NAME(...)` before the
	 * rest of the declaration, or a bare `NAME` alone on its line. `index` when none stands there.
	 */
	protected attributeMacroEnd(index: number, limit: number): number {
		const token = tokenAt(this.tokens, index);
		if (token?.kind !== "identifier" || !isShoutCase(token.value)) return index;
		const next = significantAfter(this.tokens, index, limit);
		if (tokenAt(this.tokens, next)?.text === "(") {
			const close = matching(this.tokens, next, "(", ")", limit);
			const after = tokenAt(this.tokens, this.codeAfter(close, limit));
			const declares = after?.kind === "identifier" && !DECLARATOR_CONTINUATIONS.has(after.value);
			return close >= 0 && declares ? close + 1 : index;
		}
		if (this.isStandaloneMacroPrefix(index, next, tokenAt(this.tokens, next), limit)) return index + 1;
		// A bare word before an attribute macro on its line, `WARN DEPRECATED(...) static T f()`.
		const line = token.start.line;
		const onLine = (at: number) => at >= 0 && tokenAt(this.tokens, at)?.start.line === line;
		const end = onLine(next) ? this.attributeMacroEnd(next, limit) : -1;
		return end > next && onLine(this.codeAfter(end - 1, limit)) ? index + 1 : index;
	}

	protected declarationSpecifierEnd(index: number, limit: number): number | undefined {
		const token = tokenAt(this.tokens, index);
		const next = significantAfter(this.tokens, index, limit);
		const isBracketSpecifier = token?.text === "[" && tokenAt(this.tokens, next)?.text === "[";
		if (isBracketSpecifier) {
			const close = matching(this.tokens, index, "[", "]", limit);
			if (close < 0) {
				this.addDiagnostic("Attribute specifier is not closed.", index);
				return -1;
			}
			return close + 1;
		}
		if (token?.kind !== "identifier" || !DECLARATION_SPECIFIERS.has(token.value)) return undefined;
		if (tokenAt(this.tokens, next)?.text !== "(") return undefined;
		const close = matching(this.tokens, next, "(", ")", limit);
		if (close < 0) {
			this.addDiagnostic("Attribute specifier is not closed.", index);
			return -1;
		}
		return close + 1;
	}

	protected templateInfo(openIndex: number, closeIndex: number, startIndex: number): TemplateInfo {
		const parameters: TemplateParameter[] = [];
		let segmentStart = openIndex + 1;
		let depth = 0;
		let templates = 0;
		for (let index = openIndex + 1; index <= closeIndex; index++) {
			const token = tokenAt(this.tokens, index);
			const value = token?.text;
			const closing = index === closeIndex;
			if (value === "(" || value === "[" || value === "{") depth++;
			else if (value === ")" || value === "]" || value === "}") depth = Math.max(0, depth - 1);
			else if (!closing) templates = Math.max(0, templates + bracketDelta(token, this.angles));
			if (!closing && (value !== "," || depth !== 0 || templates !== 0)) continue;
			// The name stands before a default, which may hold names of its own.
			const nameIndex = this.parameterName(
				segmentStart,
				this.topLevelStop(segmentStart - 1, index, isAssignment),
			);
			if (nameIndex >= 0) {
				// A `>>` closing the last default's list and this one: the parameter keeps its first half.
				const splitEnd = closing && value === ">>" && templates === 1;
				parameters.push({
					name: tokenAt(this.tokens, nameIndex)?.value ?? "",
					nameStartIndex: nameIndex,
					nameEndIndex: nameIndex + 1,
					startIndex: significantAfter(this.tokens, segmentStart - 1),
					endIndex: splitEnd ? index + 1 : index,
					typeText: joinTokens(this.tokens, segmentStart, nameIndex),
					...(splitEnd ? { splitEnd } : {}),
				});
			}
			segmentStart = index + 1;
		}
		this.markRange(startIndex, closeIndex + 1);
		return { startIndex, endIndex: closeIndex + 1, parameters };
	}

	/**
	 * A template parameter's name in `[start, stop)`: the last name outside brackets, unless it stands
	 * first, template arguments follow it or a `::` precedes it, when it is an unnamed parameter's type.
	 */
	protected parameterName(start: number, stop: number): number {
		let templates = 0;
		let name = -1;
		for (let index = start; index < stop; index++) {
			const token = tokenAt(this.tokens, index);
			if (token === undefined || !isSignificant(token)) continue;
			const delta = bracketDelta(token, this.angles);
			templates = Math.max(0, templates + delta);
			if (templates > 0 || delta !== 0) continue;
			if (token.text === "(") index = Math.max(index, matching(this.tokens, index, "(", ")", stop));
			else if (isNameToken(token)) name = index;
		}
		if (name < 0 || name === significantAfter(this.tokens, start - 1)) return -1;
		if (bracketDelta(tokenAt(this.tokens, significantAfter(this.tokens, name)), this.angles) > 0) return -1;
		return tokenAt(this.tokens, significantBefore(this.tokens, name))?.text === "::" ? -1 : name;
	}

	/** Declarators after a class or enum body up to their `;`; null when none stand there. */
	protected trailingDeclarators(close: number, limit: number): { segments: TokenSpan[]; end: number } | null {
		const next = significantAfter(this.tokens, close, limit);
		const value = tokenAt(this.tokens, next)?.text;
		if (next < 0 || value === ";" || value === "}") return null;
		const end = statementEnd(this.tokens, close + 1, limit);
		if (tokenAt(this.tokens, end)?.text !== ";") return null;
		const segments = this.declaratorSegments(close + 1, end + 1);
		const first = segments[0];
		const site = first === undefined ? null : this.declaratorIn(first.start, first.end);
		// Only declarators: a missing `;` would otherwise take in the next declaration.
		if (site === null || this.significantIndexes(close + 1, site.start).length > 0) return null;
		return { segments, end };
	}

	/**
	 * A class head after its key: attributes, macro words before the name, a qualified or templated
	 * name, `final` and bases. Null unless a body or `;` follows: an elaborated type in a declaration.
	 */
	protected classHead(keywordIndex: number, limit: number): ClassHead | null {
		let index = this.pastAttributes(significantAfter(this.tokens, keywordIndex, limit), limit);
		let chain = this.nameChain(index, limit);
		const macros: number[] = [];
		// `class DOCTEST_INTERFACE String {`: a lone macro word, then the name.
		while (
			chain !== null &&
			chain.start === chain.name &&
			isShoutCase(tokenAt(this.tokens, chain.name)?.value ?? "") &&
			isNameToken(tokenAt(this.tokens, chain.end))
		) {
			macros.push(chain.name);
			index = chain.end;
			chain = this.nameChain(index, limit);
		}
		let after = chain?.end ?? index;
		const afterFinal = significantAfter(this.tokens, after, limit);
		const following = tokenAt(this.tokens, afterFinal)?.text;
		if (tokenAt(this.tokens, after)?.text === "final" && (following === "{" || following === ":"))
			after = afterFinal;
		const value = tokenAt(this.tokens, after)?.text;
		const name = chain?.name ?? -1;
		const qualifierStart = chain?.start ?? -1;
		if (value === "{") return { name, qualifierStart, body: after, end: -1, bases: -1, macros };
		if (value === ":") {
			const body = this.topLevelStop(after, limit, (stop) => stop === "{" || stop === ";");
			if (tokenAt(this.tokens, body)?.text !== "{") return null;
			return { name, qualifierStart, body, end: -1, bases: after, macros };
		}
		if (value === ";" && name >= 0 && macros.length === 0)
			return { name, qualifierStart, body: -1, end: after, bases: -1, macros };
		return null;
	}

	/** An enum head after `enum` or its `class` key: a name and an underlying type; null when elaborated. */
	protected enumHead(keyIndex: number, limit: number): ClassHead | null {
		const index = this.pastAttributes(significantAfter(this.tokens, keyIndex, limit), limit);
		const chain = this.nameChain(index, limit);
		const after = chain?.end ?? index;
		const value = tokenAt(this.tokens, after)?.text;
		const name = chain?.name ?? -1;
		const qualifierStart = chain?.start ?? -1;
		const stop = value === ":" ? this.topLevelStop(after, limit, (found) => found === "{" || found === ";") : after;
		const stopValue = tokenAt(this.tokens, stop)?.text;
		if (stopValue === "{") return { name, qualifierStart, body: stop, end: -1, bases: -1, macros: [] };
		if (stopValue === ";" && name >= 0) return { name, qualifierStart, body: -1, end: stop, bases: -1, macros: [] };
		return null;
	}

	/** Past attributes and declaration specifiers at `index`, their names left out of references. */
	protected pastAttributes(index: number, limit: number): number {
		let current = index;
		for (let end = this.attributeEnd(current, limit); end > current; end = this.attributeEnd(current, limit)) {
			for (let inside = current; inside < end; inside++) {
				this.declarationSpecifierTokenIndexes.add(inside);
				if (tokenAt(this.tokens, inside)?.kind === "identifier") this.excludedTokenIndexes.add(inside);
			}
			current = significantAfter(this.tokens, end - 1, limit);
		}
		return current;
	}

	/** A name, qualified and with template arguments, from `index`: `::a::B<T>::C`. */
	protected nameChain(index: number, limit: number): { start: number; name: number; end: number } | null {
		let name = tokenAt(this.tokens, index)?.text === "::" ? significantAfter(this.tokens, index, limit) : index;
		if (!isNameToken(tokenAt(this.tokens, name))) return null;
		for (;;) {
			let after = significantAfter(this.tokens, name, limit);
			if (bracketDelta(tokenAt(this.tokens, after), this.angles) > 0) {
				const close = this.angleClose(after, limit);
				if (close < 0) return { start: index, name, end: after };
				after = significantAfter(this.tokens, close, limit);
			}
			const next = significantAfter(this.tokens, after, limit);
			if (tokenAt(this.tokens, after)?.text !== "::" || !isNameToken(tokenAt(this.tokens, next)))
				return { start: index, name, end: after };
			name = next;
		}
	}

	/** The token closing the template list opening at `open`: `open` when it opens none, -1 when unclosed. */
	protected angleClose(open: number, limit: number): number {
		let depth = 0;
		for (let index = open; index < limit; index++) {
			depth += bracketDelta(tokenAt(this.tokens, index), this.angles);
			if (depth <= 0) return index;
		}
		return -1;
	}

	protected functionOpen(prefix: Prefix, limit: number): number {
		let parentheses = 0;
		let brackets = 0;
		let templates = 0;
		for (let index = prefix.keywordIndex; index < limit; index++) {
			if (this.directiveTokens.has(index)) continue;
			const token = tokenAt(this.tokens, index);
			const value = token?.text;
			if (value === "[") brackets++;
			else if (value === "]") brackets = Math.max(0, brackets - 1);
			if (brackets > 0) continue;
			// A function type in a template argument, `std::function<int(int)>`, declares nothing.
			const delta = parentheses === 0 ? bracketDelta(token, this.angles) : 0;
			templates = Math.max(0, templates + delta);
			if (templates > 0 || delta !== 0) continue;
			if (value === "(") {
				const previous = significantBefore(this.tokens, index);
				if (parentheses === 0 && tokenAt(this.tokens, previous)?.text === "operator") {
					const operatorClose = matching(this.tokens, index, "(", ")", limit);
					const next = operatorClose < 0 ? -1 : significantAfter(this.tokens, operatorClose, limit);
					if (operatorClose >= 0 && tokenAt(this.tokens, next)?.text === "(") {
						index = operatorClose;
						continue;
					}
				}
				// `size_t (C::*fn)(int)` declares a pointer, whatever its name before `(` looks like.
				const nested = parentheses === 0 && this.opensNestedDeclarator(index, limit);
				if (parentheses === 0 && !nested && this.functionName(index, prefix) !== null) return index;
				parentheses++;
			}
			if (value === ")") parentheses = Math.max(0, parentheses - 1);
			if (parentheses === 0 && (value === ";" || value === "{" || value === "=" || value === ",")) {
				// `operator=` and `operator,` name a function.
				if (tokenAt(this.tokens, significantBefore(this.tokens, index))?.text === "operator") continue;
				return -1;
			}
		}
		return -1;
	}

	protected functionName(openIndex: number, prefix: Prefix): FunctionName | null {
		const previous = significantBefore(this.tokens, openIndex);
		const previousToken = tokenAt(this.tokens, previous);
		if (previousToken === undefined) return null;
		let name = "";
		let nameStartIndex = previous;
		let nameEndIndex = previous + 1;
		// Where the unqualified id starts: `operator` for a literal operator named by its suffix.
		let idStart = -1;
		const operator = this.operatorBefore(openIndex, prefix.keywordIndex);
		if (operator >= 0) {
			idStart = operator;
			// `operator==`, `operator()`, `operator new[]`, a conversion `operator std::string`, and a
			// literal operator `operator "" _json`, named by its suffix.
			const first = significantAfter(this.tokens, operator, openIndex);
			const suffix = joinTokens(this.tokens, operator + 1, openIndex);
			const firstToken = tokenAt(this.tokens, first);
			const literalIndex = firstToken?.kind === "string" ? significantAfter(this.tokens, first, openIndex) : -1;
			const literal = tokenAt(this.tokens, literalIndex);
			if (literal?.kind === "identifier") {
				name = literal.value;
				nameStartIndex = literalIndex;
				nameEndIndex = literalIndex + 1;
			} else {
				name = `operator${firstToken?.kind === "identifier" ? " " : ""}${suffix}`;
				nameStartIndex = operator;
				nameEndIndex = openIndex;
			}
		} else if (previousToken.text === ">" || previousToken.text === ">>") {
			const templateName = this.templateNameBefore(openIndex, prefix);
			if (templateName === null) return null;
			name = templateName.name;
			nameStartIndex = templateName.nameStartIndex;
			nameEndIndex = openIndex;
		} else if (isNameToken(previousToken)) {
			name = previousToken.value;
			const beforeName = significantBefore(this.tokens, previous);
			if (tokenAt(this.tokens, beforeName)?.text === "~") {
				name = `~${name}`;
				nameStartIndex = beforeName;
			}
		} else {
			return null;
		}
		if (CONTROL_NAMES.has(name) || CONTROL_NAMES.has(previousToken.value)) return null;
		if (idStart < 0) idStart = nameStartIndex;
		const beforeName = significantBefore(this.tokens, idStart);
		const beforeValue = tokenAt(this.tokens, beforeName)?.text;
		if (
			beforeName >= prefix.keywordIndex &&
			(beforeValue === "=" || beforeValue === "," || beforeValue === "return")
		)
			return null;
		const qualifier: string[] = [];
		let qualifierStart = idStart;
		let templatedQualifiers = 0;
		let current = significantBefore(this.tokens, idStart);
		while (current >= prefix.keywordIndex && tokenAt(this.tokens, current)?.text === "::") {
			const qualifierName = significantBefore(this.tokens, current);
			const segment = this.templateQualifierBefore(qualifierName, prefix.keywordIndex);
			if (segment === null) break;
			qualifier.unshift(segment.name);
			if (segment.startIndex !== qualifierName) templatedQualifiers++;
			qualifierStart = segment.startIndex;
			current = significantBefore(this.tokens, segment.startIndex);
		}
		return { name, nameStartIndex, nameEndIndex, qualifier, qualifierStart, templatedQualifiers };
	}

	/**
	 * The `operator` whose id runs up to `openIndex`, or -1. Brackets in the id are only `()` right
	 * after the keyword, so an `operator` inside an earlier `decltype(...)` names nothing here.
	 */
	protected operatorBefore(openIndex: number, lower: number): number {
		const operator = this.findPreviousText(openIndex, "operator", lower);
		if (operator < 0) return -1;
		const call = significantAfter(this.tokens, operator, openIndex);
		const callClose =
			tokenAt(this.tokens, call)?.text === "(" ? significantAfter(this.tokens, call, openIndex) : -1;
		const skip = tokenAt(this.tokens, callClose)?.text === ")" ? callClose : operator;
		for (let index = skip + 1; index < openIndex; index++) {
			const value = tokenAt(this.tokens, index)?.text;
			if (value === "(" || value === ")" || value === ";" || value === "{" || value === "}") return -1;
		}
		return operator;
	}

	protected templateQualifierBefore(index: number, lower: number): { name: string; startIndex: number } | null {
		const token = tokenAt(this.tokens, index);
		if (token?.kind === "identifier") return { name: token.value, startIndex: index };
		const open = this.angleOpenBefore(index, lower);
		if (open < 0) return null;
		const nameIndex = significantBefore(this.tokens, open);
		const name = tokenAt(this.tokens, nameIndex);
		return name?.kind === "identifier" ? { name: name.value, startIndex: nameIndex } : null;
	}

	protected templateNameBefore(openIndex: number, prefix: Prefix): { name: string; nameStartIndex: number } | null {
		const open = this.angleOpenBefore(significantBefore(this.tokens, openIndex), prefix.keywordIndex);
		if (open < 0) return null;
		const nameIndex = significantBefore(this.tokens, open);
		const nameToken = tokenAt(this.tokens, nameIndex);
		if (nameToken === undefined || nameToken.kind !== "identifier" || KEYWORDS.has(nameToken.value)) return null;
		return { name: nameToken.value, nameStartIndex: nameIndex };
	}

	/** The `<` opening the outermost list that the template `>` or `>>` at `close` ends; -1 when none. */
	protected angleOpenBefore(close: number, lower: number): number {
		let depth = 0;
		for (let index = close; index >= lower; index--) {
			const delta = bracketDelta(tokenAt(this.tokens, index), this.angles);
			if (index === close && delta >= 0) return -1;
			depth -= delta;
			if (delta > 0 && depth <= 0) return index;
		}
		return -1;
	}

	/** A specialization's name with its arguments, `Box<T*>`, so it is not the primary template. */
	protected typeDescriptorName(prefix: Prefix, nameIndex: number, limit: number, name: string): string {
		if (name === "" || prefix.template === null) return name;
		const open = significantAfter(this.tokens, nameIndex, limit);
		if (tokenAt(this.tokens, open)?.text !== "<") return name;
		const close = this.angleClose(open, limit);
		return close <= open ? name : joinTokens(this.tokens, nameIndex, close + 1);
	}

	/**
	 * What follows a parameter list: the body's `{`, else the `;` ending the declaration. Qualifiers,
	 * a trailing return, a constraint, `= 0` and a member initializer list are read past; `try`
	 * before the body means handlers follow it.
	 */
	protected functionTail(closeIndex: number, limit: number): FunctionTail {
		if (this.startsNextDeclaration(closeIndex, limit)) return { body: -1, end: closeIndex, tryBlock: false };
		let depth = 0;
		let templates = 0;
		let tryBlock = false;
		for (let index = closeIndex + 1; index < limit; index++) {
			if (this.directiveTokens.has(index)) continue;
			const token = tokenAt(this.tokens, index);
			const value = token?.text;
			if (value === "(" || value === "[") depth++;
			else if (value === ")" || value === "]") depth = Math.max(0, depth - 1);
			else if (depth === 0) templates = Math.max(0, templates + bracketDelta(token, this.angles));
			if (depth !== 0 || templates !== 0) continue;
			if (value === "{") return { body: index, end: index, tryBlock };
			if (value === ";" || value === ",") return { body: -1, end: index, tryBlock };
			if (value === "try" && token?.kind === "identifier") tryBlock = true;
			if (value === ":") {
				const body = this.memberInitializersEnd(index, limit);
				if (body >= 0) return { body, end: body, tryBlock };
			}
		}
		return { body: -1, end: Math.max(closeIndex, limit - 1), tryBlock };
	}

	/**
	 * A name on a later line after the `)` at `close` that nothing continuing a declarator is: the
	 * next declaration, so a call missing its `;`, as a macro's, keeps to its own line.
	 */
	private startsNextDeclaration(close: number, limit: number): boolean {
		const next = this.codeAfter(close, limit);
		const token = tokenAt(this.tokens, next);
		if (token?.kind !== "identifier" || token.start.line <= (tokenAt(this.tokens, close)?.end.line ?? -1))
			return false;
		if (DECLARATOR_CONTINUATIONS.has(token.value) || isShoutCase(token.value)) return false;
		return this.declarationSpecifierEnd(next, limit) === undefined;
	}

	/** The body's `{` after a member initializer list opening at `colon`; -1 when the list is malformed. */
	protected memberInitializersEnd(colon: number, limit: number): number {
		let index = this.codeAfter(colon, limit);
		let guard = -1;
		while (index >= 0) {
			if (index <= guard) throw new Error("member initializer scan failed to advance");
			guard = index;
			const open = this.initializerNameEnd(index, limit);
			const opener = tokenAt(this.tokens, open)?.text;
			if (opener !== "(" && opener !== "{") return -1;
			const close = matching(this.tokens, open, opener, opener === "(" ? ")" : "}", limit);
			if (close < 0) return -1;
			index = this.codeAfter(close, limit);
			if (tokenAt(this.tokens, index)?.text === "...") index = this.codeAfter(index, limit);
			const next = tokenAt(this.tokens, index)?.text;
			if (next === "{") return index;
			if (next !== ",") return -1;
			index = this.codeAfter(index, limit);
		}
		return -1;
	}

	/** The `(` or `{` after a member initializer's name, qualified, templated or `decltype`; -1 otherwise. */
	protected initializerNameEnd(start: number, limit: number): number {
		let templates = 0;
		for (let index = start; index >= 0; index = this.codeAfter(index, limit)) {
			const token = tokenAt(this.tokens, index);
			const delta = bracketDelta(token, this.angles);
			templates = Math.max(0, templates + delta);
			if (templates > 0 || delta !== 0) continue;
			const value = token?.text;
			if (value === "(" || value === "{") return index;
			if (value === "decltype") {
				const open = this.codeAfter(index, limit);
				index = tokenAt(this.tokens, open)?.text === "(" ? matching(this.tokens, open, "(", ")", limit) : -1;
				if (index < 0) return -1;
				continue;
			}
			if (token?.kind !== "identifier" && value !== "::") return -1;
		}
		return -1;
	}

	/** The last `catch` handler's closing brace after a function-try-block's body; the body's when none follows. */
	protected handlersEnd(bodyClose: number, limit: number): number {
		let end = bodyClose;
		let next = end < 0 ? -1 : significantAfter(this.tokens, end, limit);
		while (tokenAt(this.tokens, next)?.text === "catch") {
			const open = significantAfter(this.tokens, next, limit);
			const close = tokenAt(this.tokens, open)?.text === "(" ? matching(this.tokens, open, "(", ")", limit) : -1;
			const block = close < 0 ? -1 : significantAfter(this.tokens, close, limit);
			const blockClose =
				tokenAt(this.tokens, block)?.text === "{" ? matching(this.tokens, block, "{", "}", limit) : -1;
			if (blockClose < 0) break;
			end = blockClose;
			next = significantAfter(this.tokens, end, limit);
		}
		return end;
	}

	/** The first top-level token in `(from, to)` that `stops`, or `to`. */
	protected topLevelStop(from: number, to: number, stops: (value: string) => boolean): number {
		let depth = 0;
		let templates = 0;
		for (let index = from + 1; index < to; index++) {
			if (this.directiveTokens.has(index)) continue;
			const token = tokenAt(this.tokens, index);
			const value = token?.text ?? "";
			if (value === "(" || value === "[") depth++;
			else if (value === ")" || value === "]") depth = Math.max(0, depth - 1);
			else if (depth === 0) templates = Math.max(0, templates + bracketDelta(token, this.angles));
			if (depth === 0 && templates === 0 && stops(value)) return index;
		}
		return to;
	}

	/** Parameters in a list, unnamed ones included; `void` alone and C's `...` are none. */
	protected countParameters(startIndex: number, limit: number): number {
		return this.declaratorSegments(startIndex, limit).filter((segment) => {
			const tokens = this.significantIndexes(segment.start, segment.end);
			const only = tokens.length === 1 ? tokenAt(this.tokens, tokens[0] as number)?.text : undefined;
			return tokens.length > 0 && only !== "void" && only !== "...";
		}).length;
	}

	/** Spans between top-level commas; the last one runs to `endIndex`. */
	protected declaratorSegments(startIndex: number, endIndex: number): TokenSpan[] {
		const segments: TokenSpan[] = [];
		let segmentStart = startIndex;
		let depth = 0;
		let templates = 0;
		for (let index = startIndex; index <= endIndex; index++) {
			const token = this.directiveTokens.has(index) ? undefined : tokenAt(this.tokens, index);
			const value = token?.text;
			if (value === "(" || value === "[" || value === "{") depth++;
			else if (value === ")" || value === "]" || value === "}") depth = Math.max(0, depth - 1);
			else if (depth === 0) templates = Math.max(0, templates + bracketDelta(token, this.angles));
			if ((value === "," && depth === 0 && templates === 0) || index === endIndex) {
				segments.push({ start: segmentStart, end: index });
				segmentStart = index + 1;
			}
		}
		return segments;
	}

	/**
	 * The declarator in `[from, to)`: the last name standing outside brackets before an initializer,
	 * a bit-field width, an array bound or a parameter list, or the name inside `(*name)`. Null when
	 * there is none, or when that name takes template arguments and so names a type.
	 */
	protected declaratorIn(from: number, to: number): DeclaratorSite | null {
		let templates = 0;
		let name = -1;
		for (let index = from; index < to; index++) {
			const token = tokenAt(this.tokens, index);
			if (token === undefined || !isSignificant(token) || this.outsideCode(index)) continue;
			const attributeEnd = this.attributeEnd(index, to);
			if (attributeEnd > index) {
				index = attributeEnd - 1;
				continue;
			}
			const delta = bracketDelta(token, this.angles);
			templates = Math.max(0, templates + delta);
			if (templates > 0 || delta !== 0) continue;
			const value = token.text;
			if (value === "decltype") {
				const open = significantAfter(this.tokens, index, to);
				const close = tokenAt(this.tokens, open)?.text === "(" ? matching(this.tokens, open, "(", ")", to) : -1;
				if (close >= 0) index = close;
				continue;
			}
			if (value === "(" && this.opensNestedDeclarator(index, to)) {
				const close = matching(this.tokens, index, "(", ")", to);
				const inner = close < 0 ? null : this.declaratorIn(index + 1, close);
				if (inner === null) return null;
				const end = this.topLevelStop(close, to, (stop) => DECLARATOR_ENDS.has(stop));
				return { ...inner, start: index, call: -1, nested: close, end };
			}
			if (DECLARATOR_STOPS.has(value)) return this.siteAt(name, from, index, value === "(");
			if (value === "operator") return null;
			if (token.kind !== "identifier" && !DECLARATOR_PUNCTUATION.has(value)) return null;
			if (isNameToken(token)) name = index;
		}
		return this.siteAt(name, from, to, false);
	}

	private siteAt(name: number, from: number, end: number, call: boolean): DeclaratorSite | null {
		if (name < 0) return null;
		const next = significantAfter(this.tokens, name);
		if (bracketDelta(tokenAt(this.tokens, next), this.angles) > 0) return null;
		const qualifierStart = this.qualifierStartOf(name, from);
		return {
			start: this.pointerStartOf(qualifierStart, from),
			name,
			qualifierStart,
			call: call && next === end ? end : -1,
			nested: -1,
			end,
		};
	}

	/** `(` opening `(*name)`, `(&name)` or `(C::*name)` rather than a parameter list or an initializer. */
	private opensNestedDeclarator(open: number, limit: number): boolean {
		let index = significantAfter(this.tokens, open, limit);
		const value = tokenAt(this.tokens, index)?.text;
		if (value === "*" || value === "&" || value === "&&") return true;
		while (isNameToken(tokenAt(this.tokens, index))) {
			const separator = significantAfter(this.tokens, index, limit);
			if (tokenAt(this.tokens, separator)?.text !== "::") return false;
			index = significantAfter(this.tokens, separator, limit);
		}
		return tokenAt(this.tokens, index)?.text === "*";
	}

	/** A token a declarator is not made of: an attribute already read, or a directive line's. */
	protected outsideCode(index: number): boolean {
		return this.declarationSpecifierTokenIndexes.has(index) || this.directiveTokens.has(index);
	}

	/** The end of an attribute or declaration specifier at `index`, or `index` when none starts there. */
	protected attributeEnd(index: number, limit: number): number {
		const end = this.declarationSpecifierEnd(index, limit);
		return end === undefined || end < 0 ? index : end;
	}

	/** The first token of the qualifier written before the name at `name`: `A::B::`, or `::` alone. */
	private qualifierStartOf(name: number, from: number): number {
		let start = name;
		let before = significantBefore(this.tokens, start);
		while (before >= from && tokenAt(this.tokens, before)?.text === "::") {
			const qualifier = this.templateQualifierBefore(significantBefore(this.tokens, before), from);
			if (qualifier === null || !isNameToken(tokenAt(this.tokens, qualifier.startIndex))) return before;
			start = qualifier.startIndex;
			before = significantBefore(this.tokens, start);
		}
		return start;
	}

	/** Where a declarator begins: back from `start` over pointer operators, a pack's dots and `C::*`. */
	protected pointerStartOf(start: number, from: number): number {
		let begin = start;
		let before = significantBefore(this.tokens, begin);
		while (before >= from && this.isPointerOperator(before)) {
			begin = before;
			before = significantBefore(this.tokens, begin);
			if (tokenAt(this.tokens, begin)?.text === "*" && tokenAt(this.tokens, before)?.text === "::") {
				begin = this.qualifierStartOf(before, from);
				if (begin === before) begin = significantAfter(this.tokens, before);
				before = significantBefore(this.tokens, begin);
			}
		}
		return begin;
	}

	/** `*`, `&`, `&&`, `...`, or a cv-qualifier after `*`. */
	private isPointerOperator(index: number): boolean {
		const value = tokenAt(this.tokens, index)?.text ?? "";
		if (value === "*" || value === "&" || value === "&&" || value === "...") return true;
		if (value !== "const" && value !== "volatile") return false;
		return tokenAt(this.tokens, significantBefore(this.tokens, index))?.text === "*";
	}

	/** Type tokens a declarator adds to its specifiers: pointer operators, or a nested declarator's shape. */
	protected declaratorTypeIndexes(site: DeclaratorSite): number[] {
		if (site.nested < 0) return this.significantIndexes(site.start, site.qualifierStart);
		return this.significantIndexes(site.start, site.end).filter(
			(index) => index < site.qualifierStart || index > site.name,
		);
	}

	/** What a declaration's specifiers hold. */
	protected specifierShape(from: number, to: number): SpecifierShape {
		const shape: SpecifierShape = { clean: true, typed: false, keyworded: false, compound: false };
		let templates = 0;
		for (let index = from; index < to; index++) {
			const token = tokenAt(this.tokens, index);
			if (token === undefined || !isSignificant(token) || this.outsideCode(index)) continue;
			const attributeEnd = this.attributeEnd(index, to);
			if (attributeEnd > index) {
				index = attributeEnd - 1;
				continue;
			}
			const delta = bracketDelta(token, this.angles);
			templates = Math.max(0, templates + delta);
			if (templates > 0 || delta !== 0) {
				shape.compound = true;
				continue;
			}
			const value = token.text;
			if (value === "::") {
				shape.compound = true;
				continue;
			}
			if (value === "...") continue;
			if (token.kind !== "identifier" || (KEYWORDS.has(value) && !SPECIFIER_WORDS.has(value))) {
				shape.clean = false;
				continue;
			}
			if (value === "decltype") {
				const open = significantAfter(this.tokens, index, to);
				const close = tokenAt(this.tokens, open)?.text === "(" ? matching(this.tokens, open, "(", ")", to) : -1;
				if (close >= 0) index = close;
			}
			if (SPECIFIER_WORDS.has(value)) {
				shape.keyworded = true;
				shape.typed ||= FUNDAMENTAL_TYPES.has(value);
				continue;
			}
			shape.typed = true;
			shape.firstName ??= value;
		}
		return shape;
	}

	/** The names of a qualifier written from `start` up to the name at `name`, template arguments dropped. */
	protected writtenQualifier(start: number, name: number): string[] {
		const names: string[] = [];
		let templates = 0;
		for (let index = start; index < name; index++) {
			const token = tokenAt(this.tokens, index);
			templates = Math.max(0, templates + bracketDelta(token, this.angles));
			if (templates === 0 && isNameToken(token)) names.push(token?.value ?? "");
		}
		return names;
	}

	/** `auto [a, b]` or `auto& [a, b]` ahead of `to`: the bracket's span, or null. */
	protected structuredBinding(from: number, to: number): TokenSpan | null {
		let templates = 0;
		for (let index = from; index < to; index++) {
			const token = tokenAt(this.tokens, index);
			if (token === undefined || !isSignificant(token) || this.outsideCode(index)) continue;
			const delta = bracketDelta(token, this.angles);
			templates = Math.max(0, templates + delta);
			if (templates > 0 || delta !== 0) continue;
			const value = token.text;
			if (value === "[" && tokenAt(this.tokens, significantAfter(this.tokens, index, to))?.text !== "[") {
				const close = matching(this.tokens, index, "[", "]", to);
				const before = tokenAt(this.tokens, significantBefore(this.tokens, index))?.text;
				const bound = before === "auto" || before === "&" || before === "&&";
				return close < 0 || !bound ? null : { start: index, end: close };
			}
			if (value !== "&" && value !== "&&" && token.kind !== "identifier" && value !== "::") return null;
		}
		return null;
	}
}
