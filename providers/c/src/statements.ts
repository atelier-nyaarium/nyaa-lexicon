// A scope's statements: where each ends, the blocks it opens, and whether it declares at all.

import { MAX_NESTING, TOO_DEEP } from "@nyaa-lexicon/protocol";
import { CDeclaratorReader } from "./declarators.js";
import type { Candidate, CandidateScan, CDeclaration, FunctionCandidate, ScopeContext, Statement } from "./model.js";
import { innermost, scopeKey, visibleAt } from "./scopes.js";
import type { CToken } from "./tokens.js";
import { nextCode, qualifiedNameForIdentifier, syntaxValue, tokenValue } from "./tokenWalk.js";
import {
	C_KEYWORDS,
	CONTROL_WORDS,
	isIdentifierToken,
	isSpecifierWord,
	TAG_WORDS,
	TYPE_QUALIFIERS,
	typeWords,
} from "./words.js";

////////////////////////////////
//  Constants

export const SEMICOLON: ReadonlySet<string> = new Set([";"]);

/** What ends a parameter declaration, or starts the body after the last one. */
const PARAMETER_DECLARATION_ENDS: ReadonlySet<string> = new Set([";", "{"]);

/** What an ordinary name declares: a typedef or an object. */
const ORDINARY_KINDS: ReadonlySet<string> = new Set(["class", "variable", "constant", "function"]);

////////////////////////////////
//  Functions & Helpers

function candidateScan(start: number): CandidateScan {
	return {
		start,
		index: start,
		parentheses: 0,
		brackets: 0,
		open: { parentheses: 0, brackets: 0, braces: 0 },
		assigned: false,
	};
}

/** Counts `value` into what is open, and notes an `=` with nothing open. */
function observeTopLevel(scan: CandidateScan, value: string): void {
	const open = scan.open;
	if (value === "(") open.parentheses++;
	else if (value === ")") open.parentheses--;
	else if (value === "[") open.brackets++;
	else if (value === "]") open.brackets--;
	else if (value === "{") open.braces++;
	else if (value === "}") open.braces--;
	else if (value === "=" && open.parentheses === 0 && open.brackets === 0 && open.braces === 0) scan.assigned = true;
}

////////////////////////////////
//  Classes

export abstract class CStatementParser extends CDeclaratorReader {
	/** `for` headers whose declarations are read. */
	private readonly readHeaders = new Set<number>();

	private nesting = 0;

	private tooDeep = false;

	/** One declaration from `first` to `listEnd`. */
	protected abstract parseDeclaration(
		statement: Statement,
		context: ScopeContext,
		first: number,
		listEnd: number,
	): void;

	////////////////////////////////
	//  Statements

	private skipLabels(start: number, end: number): number {
		let index = start;
		while (index < end && isIdentifierToken(this.tokens[index])) {
			const colon = this.code(index + 1, end);
			if (tokenValue(this.tokens, colon) !== ":") return index;
			index = this.code(colon + 1, end);
		}
		return index;
	}

	/** `read` one level deeper; past the limit, one problem and nothing read. */
	protected nested(at: number, read: () => void): void {
		if (this.nesting >= MAX_NESTING) {
			if (!this.tooDeep) this.addDiagnostic(TOO_DEEP, at);
			this.tooDeep = true;
			return;
		}
		this.nesting++;
		try {
			read();
		} finally {
			this.nesting--;
		}
	}

	protected parseScope(start: number, end: number, context: ScopeContext): void {
		this.nested(start, () => this.parseStatements(start, end, context));
	}

	private parseStatements(start: number, end: number, context: ScopeContext): void {
		let index = start;
		let guard = -1;
		while (index < end) {
			if (index <= guard) throw new Error("C parser failed to advance");
			guard = index;
			index = this.code(index, end);
			if (index >= end) return;
			// Transparent in every scope, so the pairing pass and this one agree on what the brace is.
			const linkageOpen = this.linkageBlockOpen(index, end);
			if (linkageOpen >= 0) {
				const linkageClose = this.pairs.get(linkageOpen);
				if (linkageClose === undefined) {
					this.addDiagnostic("Linkage block is not closed.", linkageOpen);
					this.parseScope(linkageOpen + 1, end, context);
					return;
				}
				this.parseScope(linkageOpen + 1, linkageClose, context);
				index = linkageClose + 1;
				continue;
			}
			if (tokenValue(this.tokens, index) === "}") return;
			const statement = this.findStatement(index, end, context);
			if (statement === undefined || statement.next <= index) {
				index++;
				continue;
			}
			this.parseStatement(statement, context);
			index = statement.next;
		}
	}

	private linkageBlockOpen(start: number, end: number): number {
		if (tokenValue(this.tokens, start) !== "extern") return -1;
		const linkage = nextCode(this.tokens, start + 1, end);
		if (!this.isLinkageString(linkage)) return -1;
		const open = nextCode(this.tokens, linkage + 1, end);
		return tokenValue(this.tokens, open) === "{" ? open : -1;
	}

	private findStatement(start: number, end: number, context: ScopeContext): Statement | undefined {
		if (context.kind === "file") {
			const invocation = this.invocationClose(start, end);
			if (invocation >= 0) return { start, last: invocation, next: invocation + 1, terminator: "invocation" };
		}
		let parentheses = 0;
		let brackets = 0;
		let braces = 0;
		const conditionals: Array<{ parentheses: number; brackets: number; braces: number }> = [];
		// One head read for every `{` the statement reaches.
		const scan = candidateScan(start);
		let index = start;
		while (index < end) {
			const directive = this.directives.get(index);
			if (directive !== undefined) {
				if (["if", "ifdef", "ifndef"].includes(directive.keyword)) {
					conditionals.push({ parentheses, brackets, braces });
				} else if (["elif", "else"].includes(directive.keyword)) {
					const frame = conditionals.at(-1);
					parentheses = frame?.parentheses ?? 0;
					brackets = frame?.brackets ?? 0;
					braces = frame?.braces ?? 0;
				} else if (directive.keyword === "endif") {
					conditionals.pop();
				}
				index = directive.end;
				continue;
			}
			if (this.directiveTokens.has(index)) {
				index = this.directiveEndByToken.get(index) ?? index + 1;
				continue;
			}
			const token = this.tokens[index] as CToken;
			if (token.kind === "comment" || token.kind === "newline") {
				index++;
				continue;
			}
			const value = syntaxValue(token);
			const level = parentheses === 0 && brackets === 0 && braces === 0;
			if (value === "(") parentheses++;
			else if (value === ")") parentheses = Math.max(0, parentheses - 1);
			else if (value === "[") brackets++;
			else if (value === "]") brackets = Math.max(0, brackets - 1);
			else if (value === "{") {
				const close = this.pairs.get(index);
				if (level && this.resumeCandidate(scan, index) !== undefined) {
					const last = close ?? end - 1;
					return {
						start,
						last,
						next: Math.min(end, last + 1),
						terminator: "body",
						bodyOpen: index,
						bodyClose: last,
					};
				}
				if (level && close !== undefined && context.kind === "function" && this.opensBlock(start, index))
					return { start, last: close, next: Math.min(end, close + 1), terminator: "block" };
				if (close !== undefined && close > index && close < end) {
					index = close + 1;
					continue;
				}
				braces++;
			} else if (value === "}") {
				if (level) return { start, last: index - 1, next: index, terminator: "eof" };
				braces--;
			} else if (value === ";" && level) {
				const oldStyle = context.kind === "file" ? this.oldStyleDefinition(start, index, end) : undefined;
				return oldStyle ?? { start, last: index, next: index + 1, terminator: "semicolon" };
			}
			index++;
		}
		return start < end ? { start, last: Math.max(start, end - 1), next: end, terminator: "eof" } : undefined;
	}

	/** Whether the `{` at `open` starts a compound statement: a block, a label's, or a control statement's body. */
	private opensBlock(start: number, open: number): boolean {
		const previous = this.codeBefore(open);
		if (previous < start) return true;
		const value = tokenValue(this.tokens, previous);
		if (value === "else" || value === "do" || value === ":") return true;
		if (value !== ")") return false;
		const opener = this.pairs.get(previous);
		return opener !== undefined && CONTROL_WORDS.has(tokenValue(this.tokens, this.codeBefore(opener)));
	}

	/** A leading `NAME(...)` a later line's declaration follows with no semicolon: its `)`, or -1. */
	private invocationClose(start: number, end: number): number {
		const name = this.code(start, end);
		const token = this.tokens[name];
		if (!isIdentifierToken(token) || C_KEYWORDS.has(token.value) || isSpecifierWord(token.value)) return -1;
		const open = this.code(name + 1, end);
		const close = tokenValue(this.tokens, open) === "(" ? this.pairs.get(open) : undefined;
		if (close === undefined || close >= end) return -1;
		const after = this.code(close + 1, end);
		if (after >= end || (this.tokens[after] as CToken).start.line <= (this.tokens[close] as CToken).end.line)
			return -1;
		if (!this.looksLikeDeclaration(after, end)) return -1;
		const names = this.oldStyleNames(open, close);
		return names !== undefined && this.oldStyleBodyOpen(after, end, names) >= 0 ? -1 : close;
	}

	/** An old-style definition from `start`, its first parameter declaration ending at `semicolon`. */
	private oldStyleDefinition(start: number, semicolon: number, end: number): Statement | undefined {
		const candidate = this.findFunctionCandidate(start, semicolon);
		const names = candidate === undefined ? undefined : this.oldStyleNames(candidate.open, candidate.close);
		if (candidate === undefined || names === undefined) return undefined;
		const from = this.code(candidate.close + 1, end);
		if (from >= semicolon) return undefined;
		const bodyOpen = this.oldStyleBodyOpen(from, end, names);
		const bodyClose = bodyOpen < 0 ? undefined : this.pairs.get(bodyOpen);
		if (bodyClose === undefined) return undefined;
		return {
			start,
			last: bodyClose,
			next: Math.min(end, bodyClose + 1),
			terminator: "body",
			bodyOpen,
			bodyClose,
			parameterDeclarations: from,
		};
	}

	/** The names of an identifier-only parameter list, or undefined. */
	private oldStyleNames(open: number, close: number): Set<string> | undefined {
		const names = new Set<string>();
		for (const segment of this.splitSegments(open + 1, close)) {
			const first = this.code(segment.start, segment.end);
			const token = this.tokens[first];
			if (!isIdentifierToken(token) || typeWords(token.value) || this.code(first + 1, segment.end) < segment.end)
				return undefined;
			names.add(token.value);
		}
		return names;
	}

	/** The `{` after parameter declarations from `from` that declare only `names`, or -1. */
	private oldStyleBodyOpen(from: number, end: number, names: ReadonlySet<string>): number {
		let index = from;
		let declarations = 0;
		while (index < end) {
			if (tokenValue(this.tokens, index) === "{") return declarations > 0 ? index : -1;
			if (!this.looksLikeDeclaration(index, end)) return -1;
			const semicolon = this.topLevelIndex(index, end, PARAMETER_DECLARATION_ENDS);
			if (semicolon < 0 || tokenValue(this.tokens, semicolon) !== ";") return -1;
			const declared = this.declarators(this.readHead(index, semicolon), semicolon);
			if (declared.length === 0 || declared.some((declarator) => !names.has(declarator.name))) return -1;
			declarations++;
			index = this.code(semicolon + 1, end);
		}
		return -1;
	}

	protected findFunctionCandidate(start: number, beforeBody: number): FunctionCandidate | undefined {
		return this.resumeCandidate(candidateScan(start), beforeBody);
	}

	/** The first `name(...)` before `beforeBody` that no top-level `=` precedes, read on from where `scan` stopped. */
	private resumeCandidate(scan: CandidateScan, beforeBody: number): FunctionCandidate | undefined {
		for (; scan.index < beforeBody; scan.index++) {
			const index = scan.index;
			const token = this.tokens[index] as CToken;
			if (token.kind === "comment" || token.kind === "newline" || this.directiveTokens.has(index)) continue;
			// Balanced, so no `=` inside is at the top level.
			const argumentsClose = this.argumentsClose(index, beforeBody);
			if (argumentsClose >= 0) {
				scan.index = argumentsClose;
				continue;
			}
			const value = syntaxValue(token);
			if (value === "(" && scan.parentheses === 0 && scan.brackets === 0) {
				const candidate = this.candidateOpening(scan, index, beforeBody);
				if (candidate !== undefined) return candidate;
			} else if (value === "(") scan.parentheses++;
			else if (value === ")") scan.parentheses = Math.max(0, scan.parentheses - 1);
			else if (value === "[") scan.brackets++;
			else if (value === "]") scan.brackets = Math.max(0, scan.brackets - 1);
			observeTopLevel(scan, value);
		}
		return undefined;
	}

	/** The function whose parameter list opens at `open`, when a name precedes it and no initializer does. */
	private candidateOpening(scan: CandidateScan, open: number, beforeBody: number): FunctionCandidate | undefined {
		const close = this.pairs.get(open);
		const previous = this.codeBefore(open);
		const name = this.tokens[previous];
		const qualified = previous < 0 ? undefined : qualifiedNameForIdentifier(this.tokens, previous, beforeBody);
		if (
			close === undefined ||
			close >= beforeBody ||
			!isIdentifierToken(name) ||
			C_KEYWORDS.has(name.value) ||
			qualified === undefined ||
			scan.assigned
		)
			return undefined;
		return { nameIndex: qualified.startIndex, nameEndIndex: qualified.endIndex, name: qualified.name, open, close };
	}

	private parseStatement(statement: Statement, context: ScopeContext): void {
		if (statement.terminator === "invocation") return;
		const contentEnd = statement.terminator === "semicolon" ? statement.last : statement.last + 1;
		const first = this.skipLabels(this.code(statement.start, contentEnd), contentEnd);
		if (first >= contentEnd) return;
		const lead = this.pastAttributes(first, contentEnd);
		if (
			context.kind === "function" &&
			(!this.looksLikeDeclaration(lead, contentEnd) || this.objectLeads(lead, contentEnd, context.containerId))
		) {
			this.parseControlHeaderDeclarations(context, first, contentEnd, statement.last);
			this.parseInnerBlocks(first, contentEnd, context);
			return;
		}
		const wrapped = context.kind === "file" ? this.wrappedDeclaration(first, statement, contentEnd) : undefined;
		if (wrapped !== undefined) {
			this.parseDeclaration(statement, context, wrapped.first, wrapped.end);
			return;
		}
		const listEnd =
			statement.terminator === "body"
				? (statement.parameterDeclarations ?? (statement.bodyOpen as number))
				: contentEnd;
		this.parseDeclaration(statement, context, first, listEnd);
		if (context.kind === "function" && statement.terminator !== "body")
			this.parseInnerBlocks(first, contentEnd, context);
	}

	/**
	 * Whether a statement's first name is an object in scope, so `T * x;` multiplies. With `x` not yet
	 * declared, only a declaration reads, as Ghidra's `netif *p;` beside a `netif` parameter.
	 */
	private objectLeads(index: number, end: number, containerId: string | undefined): boolean {
		const token = this.tokens[index];
		if (!isIdentifierToken(token) || C_KEYWORDS.has(token.value) || isSpecifierWord(token.value)) return false;
		const lead = this.ordinaryAt(token.value, containerId, index);
		if (lead.length === 0 || lead.some((declaration) => declaration.kind === "class")) return false;
		let name = this.code(index + 1, end);
		while (
			name < end &&
			(tokenValue(this.tokens, name) === "*" || TYPE_QUALIFIERS.has(tokenValue(this.tokens, name)))
		)
			name = this.code(name + 1, end);
		const declared = this.tokens[name];
		return !isIdentifierToken(declared) || this.ordinaryAt(declared.value, containerId, index).length > 0;
	}

	/** The nearest ordinary declarations of `name` in scope before token `at`. */
	private ordinaryAt(name: string, containerId: string | undefined, at: number): CDeclaration[] {
		for (const scope of containerId === undefined ? [undefined] : [containerId, undefined]) {
			const visible = (this.scoped.get(scopeKey(scope, name)) ?? []).filter(
				(declaration) =>
					ORDINARY_KINDS.has(declaration.kind) &&
					declaration.languageKind !== "macro" &&
					!this.replaced.has(declaration) &&
					declaration.selectionIndex < at &&
					visibleAt(declaration, at),
			);
			if (visible.length > 0) return innermost(visible);
		}
		return [];
	}

	/** The declaration inside `MACRO(declaration)` at file scope. */
	private wrappedDeclaration(
		first: number,
		statement: Statement,
		contentEnd: number,
	): { first: number; end: number } | undefined {
		const token = this.tokens[first];
		if (!isIdentifierToken(token) || C_KEYWORDS.has(token.value) || isSpecifierWord(token.value)) return undefined;
		const open = this.code(first + 1, contentEnd);
		const close = tokenValue(this.tokens, open) === "(" ? this.pairs.get(open) : undefined;
		if (close === undefined || close >= contentEnd) return undefined;
		const after = this.code(close + 1, contentEnd);
		if (after !== (statement.terminator === "body" ? statement.bodyOpen : contentEnd)) return undefined;
		const inner = this.code(open + 1, close);
		if (!this.looksLikeDeclaration(inner, close) || this.findFunctionCandidate(inner, close) === undefined)
			return undefined;
		return { first: inner, end: close };
	}

	/** A `for` header's declarations, in a block of the loop's own that ends at `scopeClose`. */
	private parseControlHeaderDeclarations(
		context: ScopeContext,
		start: number,
		end: number,
		scopeClose: number,
	): void {
		if (tokenValue(this.tokens, start) !== "for" || this.readHeaders.has(start)) return;
		this.readHeaders.add(start);
		const open = this.code(start + 1, end);
		if (tokenValue(this.tokens, open) !== "(") return;
		const close = this.pairs.get(open);
		if (close === undefined || close <= open) return;
		const first = this.code(open + 1, close);
		const separator = this.topLevelIndex(first, close, SEMICOLON);
		if (separator < 0 || !this.looksLikeDeclaration(first, separator)) return;
		this.parseDeclaration(
			{ start: first, last: separator, next: separator + 1, terminator: "semicolon" },
			{ ...context, block: { open, close: scopeClose } },
			first,
			separator,
		);
	}

	/** Each brace block inside `[start, end)`, as a scope of its own. */
	private parseInnerBlocks(start: number, end: number, context: ScopeContext): void {
		for (let index = start; index < end; index++) {
			if (syntaxValue(this.tokens[index]) !== "{" || this.directiveTokens.has(index)) continue;
			const close = this.pairs.get(index);
			if (close === undefined || close >= end || close < index) continue;
			if (!this.aggregateBrace(index, start)) {
				const control = this.controlHeaderBeforeBrace(index, start);
				if (control >= 0) this.parseControlHeaderDeclarations(context, control, index, close);
				this.parseScope(index + 1, close, { ...context, block: { open: index, close } });
			}
			index = close;
		}
	}

	/** Where a name declared at `from` in `context`'s block is in scope; none at file or member scope. */
	protected blockScope(context: ScopeContext, from: number): Pick<Candidate, "scope"> {
		return context.block === undefined ? {} : { scope: { ...context.block, from } };
	}

	private controlHeaderBeforeBrace(brace: number, scopeStart: number): number {
		let previous = this.codeBefore(brace);
		let steps = 0;
		while (previous >= scopeStart && steps < 32) {
			if (tokenValue(this.tokens, previous) === "for") return previous;
			if (["{", "}"].includes(tokenValue(this.tokens, previous))) return -1;
			previous = this.codeBefore(previous);
			steps++;
		}
		return -1;
	}

	private aggregateBrace(index: number, scopeStart: number): boolean {
		let previous = this.codeBefore(index);
		let steps = 0;
		while (previous >= scopeStart && steps < 8) {
			const value = tokenValue(this.tokens, previous);
			if (TAG_WORDS.has(value)) return true;
			if (value === ";" || value === "{" || value === "}") return false;
			previous = this.codeBefore(previous);
			steps++;
		}
		return false;
	}
}
