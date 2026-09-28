// A C# file's facts: the declaration parse, then references, literals and comments.

import {
	type CommentSpan,
	comparePositions,
	type Declaration,
	defined,
	type FileRole,
	isTooDeep,
	type Literal,
	type Metrics,
	type Range,
	type Reference,
	TOO_DEEP,
} from "@nyaa-lexicon/protocol";
import { InnermostSweep, type Interval } from "./innermost.js";
import {
	type CsharpFacts,
	type DeclarationMeta,
	positionKey,
	type RawDeclaration,
	type Receiver,
	type Scope,
} from "./model.js";
import { CsharpStatementParser } from "./statements.js";
import { positionRange, type Token } from "./tokens.js";
import {
	ASSIGNMENT_WORDS,
	BUILTIN_TYPES,
	isIdentifier,
	isTrivia,
	LAMBDA_ATTRIBUTE_CONTEXT,
	MEMBER_OPERATORS,
	MODIFIERS,
	SKIPPED_WORDS,
	STATEMENT_BOUNDARY,
	syntaxValue,
} from "./words.js";

////////////////////////////////
//  Constants

const BRANCH_WORDS: ReadonlySet<string> = new Set(["if", "for", "foreach", "while", "catch", "case", "&&", "||", "??"]);

/** Roles that name a type. */
const TYPE_ROLES: ReadonlySet<Reference["role"]> = new Set(["typeUse", "extends", "implements", "instantiate"]);

const BASE_ROLES: ReadonlySet<Reference["role"]> = new Set(["extends", "implements"]);

/** Names a receiver chain holds before it reads as a value's. */
const MAX_RECEIVER_NAMES = 64;

/** A nullable type's `?` meets one of these before any `:`. */
const CONDITIONAL_ENDS: ReadonlySet<string> = new Set([";", ",", ")", "]", "}", "="]);

////////////////////////////////
//  Interfaces & Types

/** A body's brace walk, summarized so an enclosing body steps over it. */
interface BodyWalk {
	/** Deepest opening brace, from a depth of zero that never goes below zero. */
	nesting: number;
	/** Where that walk ends. */
	depth: number;
	/** The walk's unclamped change. */
	net: number;
	/** Highest unclamped depth after an opening brace; -Infinity without one. */
	peak: number;
	branches: number;
	/** First token past the body. */
	stop: number;
}

/** A type argument list a walk has opened: its `<`, the walk's depth and groups there, its count so far. */
interface ArgumentList {
	open: number;
	depth: number;
	groups: number;
	count: number;
}

////////////////////////////////
//  Classes

export class CsharpParser extends CsharpStatementParser {
	/** Whether each `?` asked about opens a conditional. */
	private readonly conditionals = new Map<number, boolean>();

	/** Each type argument list's count of arguments, by its `<`; 0 when it is none. */
	private readonly argumentCounts = new Map<number, number>();

	parse(): CsharpFacts {
		if (this.module.endsWith(".cs")) {
			this.checkDelimiters();
			try {
				this.parseScope(0, this.tokens.length - 1, undefined);
			} catch (error) {
				if (!isTooDeep(error)) throw error;
				this.gauge.reset();
				this.report(TOO_DEEP, this.token(this.deepest));
			}
		}
		const finalized = this.finalizeDeclarations();
		if (!this.outline) this.scanNestedAttributes(finalized.metadata);
		// An outline keeps base lists, which binding follows across files.
		const only = this.outline
			? (token: Token) => BASE_ROLES.has(this.roleByOffset.get(token.startOffset) ?? "read")
			: undefined;
		const accesses = this.memberAccesses(only);
		const typeArities = new Map<string, number>();
		const references = this.extractReferences(finalized.metadata, accesses.qualified, typeArities, only);
		const literals = this.outline ? [] : this.extractLiterals(finalized.metadata);
		const comments = this.outline ? [] : this.extractComments();
		const diagnostics = this.diagnostics
			.map((item) => ({ ...item, path: this.module }))
			.sort((left, right) => {
				const a = left.range?.start ?? { line: Number.MAX_SAFE_INTEGER, character: Number.MAX_SAFE_INTEGER };
				const b = right.range?.start ?? { line: Number.MAX_SAFE_INTEGER, character: Number.MAX_SAFE_INTEGER };
				return comparePositions(a, b);
			});
		return {
			module: this.module,
			role: this.fileRole(finalized.declarations, finalized.metadata),
			declarations: finalized.declarations,
			references,
			imports: this.rawImports.map((directive) => {
				const scope = this.importScopes.get(directive);
				return scope === undefined ? directive : { ...directive, scopeId: this.pathFor(scope, new Map()) };
			}),
			literals,
			comments,
			blankLines: this.lexed.blankLines,
			diagnostics,
			metadata: finalized.metadata,
			namespaceNames: [...this.namespaceNames].sort(),
			attributeNames: this.attributeNames,
			baseListNames: this.baseListNames,
			receivers: accesses.receivers,
			receiverNames: accesses.receiverNames,
			typeArities,
		};
	}

	private fileRole(declarations: Declaration[], metadata: Map<string, DeclarationMeta>): FileRole {
		const main = declarations.find((declaration) => {
			if (declaration.kind !== "method" || declaration.name !== "Main") return false;
			return metadata.get(declaration.symbolId)?.isStatic === true;
		});
		if (main !== undefined) return { kind: "entry", how: "main", symbolId: main.symbolId };
		if (this.skippedFileScope) return { kind: "unknown", reason: "NotImplemented" };
		return { kind: "library" };
	}

	/** Statement-boundary runs are attributes only inside method-shaped bodies. At expression starts,
	 * only runs before lambdas, anonymous methods, or their parameter lists are attributes.
	 */
	private scanNestedAttributes(metadata: Map<string, DeclarationMeta>): void {
		const end = this.tokens.length;
		const bodies = new InnermostSweep(this.runningBodyRanges(metadata));
		for (let current = 0; current < end; current++) {
			if (this.value(current) !== "[") continue;
			const previous = this.previousSignificant(current);
			const previousValue = this.value(previous);
			if (previousValue === undefined) continue;
			const token = this.token(current) as Token;
			const boundary = STATEMENT_BOUNDARY.has(previousValue) && bodies.at(token.startOffset) !== undefined;
			const anonymousMethodParameter = previousValue === "(" && this.precededByDelegateKeyword(previous);
			if (!boundary && !anonymousMethodParameter && !LAMBDA_ATTRIBUTE_CONTEXT.has(previousValue)) continue;
			const after = this.bracketedSectionsEnd(current, end);
			if (after === current) continue;
			const verified = anonymousMethodParameter
				? true
				: boundary
					? this.looksLikeLocalFunctionSignature(after, end)
					: this.looksLikeLambdaSignature(after, end);
			if (!verified) continue;
			let mark = current;
			while (mark < after) {
				const section = this.attributeSectionAt(mark, end);
				if (section === undefined || section.close < 0) break;
				mark = section.close + 1;
			}
		}
	}

	protected looksLikeLambdaSignature(index: number, end: number): boolean {
		let current = this.nextSignificant(index, end);
		while (this.value(current) === "static" || this.value(current) === "async") {
			current = this.nextSignificant(current + 1, end);
		}
		if (this.value(current) === "delegate") {
			const afterKeyword = this.nextSignificant(current + 1, end);
			if (this.value(afterKeyword) !== "(") return this.value(afterKeyword) === "{";
			const close = this.matching(afterKeyword, "(", ")", end);
			return close >= 0 && this.value(this.nextSignificant(close + 1, end)) === "{";
		}
		if (this.value(current) === "(") {
			const close = this.matching(current, "(", ")", end);
			return close >= 0 && this.value(this.nextSignificant(close + 1, end)) === "=>";
		}
		return isIdentifier(this.token(current)) && this.value(this.nextSignificant(current + 1, end)) === "=>";
	}

	/** Whether `(` opens an anonymous method's own parameter list. */
	protected precededByDelegateKeyword(parenIndex: number): boolean {
		let current = this.previousSignificant(parenIndex);
		while (this.value(current) === "static" || this.value(current) === "async") {
			current = this.previousSignificant(current);
		}
		return this.value(current) === "delegate";
	}

	/** Whether a local function signature follows, never a bare call. */
	protected looksLikeLocalFunctionSignature(index: number, end: number): boolean {
		let current = this.nextSignificant(index, end);
		while (isIdentifier(this.token(current)) && MODIFIERS.has(this.value(current) ?? "")) {
			current = this.nextSignificant(current + 1, end);
		}
		let sawType = false;
		for (;;) {
			if (!isIdentifier(this.token(current))) return false;
			current = this.nextSignificant(current + 1, end);
			while (current >= 0 && current < end) {
				const value = this.value(current);
				if (value === "<") {
					const close = this.listClose(current, end);
					if (close < 0) return false;
					current = this.nextSignificant(close + 1, end);
					continue;
				}
				if (value === "[") {
					const close = this.matching(current, "[", "]", end);
					if (close < 0) return false;
					current = this.nextSignificant(close + 1, end);
					continue;
				}
				if (value === "?" || value === "." || value === "::") {
					current = this.nextSignificant(current + 1, end);
					continue;
				}
				break;
			}
			if (this.value(current) === "(") {
				if (!sawType) return false;
				const close = this.matching(current, "(", ")", end);
				if (close < 0) return false;
				const after = this.value(this.nextSignificant(close + 1, end));
				return after === "{" || after === "=>";
			}
			sawType = true;
		}
	}

	/** Body spans a local function could sit among. */
	private runningBodyRanges(metadata: Map<string, DeclarationMeta>): Interval<true>[] {
		const ranges: Interval<true>[] = this.accessorBodyRanges.map((range) => ({ ...range, value: true }));
		for (const item of metadata.values()) {
			if (item.bodyStartOffset === undefined || item.bodyEndOffset === undefined) continue;
			const kind = item.declaration.kind;
			if (kind !== "method" && kind !== "constructor" && kind !== "operator" && kind !== "function") continue;
			ranges.push({ start: item.bodyStartOffset, end: item.bodyEndOffset, value: true });
		}
		return ranges;
	}

	/**
	 * A generic type carries its arity, as .NET names it (`List(1)#`, for List`1). Siblings still on
	 * one descriptor would share an id and overwrite each other, so any such, as a partial type's
	 * second part in the file, takes its occurrence in source order.
	 */
	private separateSiblings(arity: ReadonlyMap<RawDeclaration, number>): void {
		for (const raw of this.rawDeclarations) {
			const count = arity.get(raw) ?? 0;
			if (raw.descriptor?.kind === "type" && raw.descriptor.disambiguator === undefined && count > 0)
				raw.descriptor = { ...raw.descriptor, disambiguator: String(count) };
		}
		const order = new Map(this.rawDeclarations.map((raw, index) => [raw, index]));
		const groups = new Map<string, RawDeclaration[]>();
		for (const raw of this.rawDeclarations) {
			if (raw.descriptor === undefined) continue;
			const { kind, name, disambiguator } = raw.descriptor;
			const parent = raw.parent === undefined ? -1 : order.get(raw.parent);
			const key = JSON.stringify([parent, raw.qualifier, kind, name, disambiguator]);
			const group = groups.get(key);
			if (group === undefined) groups.set(key, [raw]);
			else group.push(raw);
		}
		for (const group of groups.values())
			for (const [index, raw] of group.entries())
				if (index > 0 && raw.descriptor !== undefined)
					raw.descriptor = { ...raw.descriptor, occurrence: index + 1 };
	}

	/** Each generic declaration's count of type parameters. */
	private arities(): Map<RawDeclaration, number> {
		const arity = new Map<RawDeclaration, number>();
		for (const raw of this.rawDeclarations)
			if (raw.kind === "typeParameter" && raw.parent !== undefined)
				arity.set(raw.parent, (arity.get(raw.parent) ?? 0) + 1);
		return arity;
	}

	private finalizeDeclarations(): { declarations: Declaration[]; metadata: Map<string, DeclarationMeta> } {
		const arity = this.arities();
		this.separateSiblings(arity);
		const cache = new Map<RawDeclaration, string>();
		const declarations: Declaration[] = [];
		const metadata = new Map<string, DeclarationMeta>();
		const bodies = this.walkBodies();
		for (const raw of this.rawDeclarations) {
			const symbolId = this.pathFor(raw, cache);
			const containerId = raw.parent === undefined ? undefined : this.pathFor(raw.parent, cache);
			const lines = raw.endToken.end.line - raw.startToken.start.line + 1;
			const metrics: Metrics = { lines: Math.max(1, lines) };
			if (raw.parameterCount !== undefined) metrics.parameters = raw.parameterCount;
			const body = bodies.get(raw);
			if (body !== undefined) {
				metrics.nesting = body.nesting;
				metrics.branches = body.branches + 1;
			}
			const declaration: Declaration = {
				symbolId,
				kind: raw.kind,
				...defined({ languageKind: raw.languageKind }),
				name: raw.name,
				range: { start: raw.startToken.start, end: raw.endToken.end },
				selectionRange: { start: raw.selectionStart.start, end: raw.selectionEnd.end },
				visibility: raw.visibility,
				exported: raw.exported,
				...defined({ signature: raw.signature, containerId, memberInsertLine: raw.memberInsertLine }),
				metrics,
			};
			declarations.push(declaration);
			metadata.set(symbolId, {
				declaration,
				startOffset: raw.startToken.startOffset,
				endOffset: raw.endToken.endOffset,
				namespaceName: this.namespaceName(raw.parent),
				typePath: this.typePath(raw.parent, arity),
				...defined({ parentId: containerId }),
				...defined({
					typeText: raw.typeText,
					typeSegments: raw.typeSegments,
					typeQualifier: raw.typeQualifier,
					inferredType: raw.inferredType,
					isPartial: raw.isPartial,
					isStatic: raw.isStatic,
				}),
				...(raw.bodyStartToken === undefined ? {} : { bodyStartOffset: raw.bodyStartToken.endOffset }),
				...(raw.bodyEndToken === undefined ? {} : { bodyEndOffset: raw.bodyEndToken.startOffset }),
				...defined({ parameterCount: raw.parameterCount, arity: arity.get(raw) }),
				...(raw.scope === undefined ? {} : { scope: this.scopeRange(raw.scope) }),
				...(raw.declarator === undefined
					? {}
					: {
							declarator: {
								startOffset: raw.declarator.start.startOffset,
								endOffset: raw.declarator.end.endOffset,
							},
						}),
			});
		}
		return { declarations, metadata };
	}

	private scopeRange(scope: Scope): Range {
		const last = this.tokens.length - 1;
		const from = this.token(Math.min(last, scope.from)) as Token;
		const to = this.token(Math.min(last, Math.max(scope.from, scope.to))) as Token;
		return { start: from.start, end: to.end };
	}

	/** Every body's walk, inner bodies first, so each token is walked once however deep bodies nest. */
	private walkBodies(): Map<RawDeclaration, BodyWalk> {
		const bodies: { raw: RawDeclaration; first: number; stop: number }[] = [];
		for (const raw of this.rawDeclarations) {
			if (raw.bodyStartToken === undefined || raw.bodyEndToken === undefined) continue;
			const first = this.firstTokenAfter(raw.bodyStartToken.endOffset);
			bodies.push({ raw, first, stop: Math.max(first, this.firstTokenAfter(raw.bodyEndToken.startOffset - 1)) });
		}
		bodies.sort((left, right) => right.first - left.first || left.stop - right.stop);
		const walked = new Map<number, BodyWalk>();
		const found = new Map<RawDeclaration, BodyWalk>();
		for (const body of bodies) {
			const walk = this.walkBody(body.first, body.stop, walked);
			found.set(body.raw, walk);
			walked.set(body.first, walk);
		}
		return found;
	}

	/** Brace depth and branches from `first` to `stop`, stepping over walked bodies inside. */
	private walkBody(first: number, stop: number, walked: ReadonlyMap<number, BodyWalk>): BodyWalk {
		let depth = 0;
		let nesting = 0;
		let net = 0;
		let peak = Number.NEGATIVE_INFINITY;
		let branches = 0;
		let guard = -1;
		for (let index = first; index < stop; index++) {
			if (index <= guard) throw new Error("body walk failed to advance");
			guard = index;
			const inner = walked.get(index);
			if (inner !== undefined && inner.stop > index && inner.stop <= stop) {
				// A walk clamped at zero, started at `depth`, ends and peaks as below.
				nesting = Math.max(nesting, depth + inner.peak, inner.nesting);
				peak = Math.max(peak, net + inner.peak);
				depth = Math.max(depth + inner.net, inner.depth);
				net += inner.net;
				branches += inner.branches;
				index = inner.stop - 1;
				continue;
			}
			const item = this.tokens[index] as Token;
			if (item.hole === true) continue;
			const value = syntaxValue(item) ?? "";
			if (value === "{") {
				depth++;
				net++;
				nesting = Math.max(nesting, depth);
				peak = Math.max(peak, net);
			} else if (value === "}") {
				depth = Math.max(0, depth - 1);
				net--;
			} else if (BRANCH_WORDS.has(value) || (value === "?" && this.isConditional(index))) {
				branches++;
			}
		}
		return { nesting, depth, net, peak, branches, stop };
	}

	/** Whether a `?` opens a conditional: its `:` comes at its own depth before its expression ends. */
	private isConditional(question: number): boolean {
		// A `?` met on the way answers for this one too, so a run of them is scanned once.
		const run: number[] = [];
		let current = question;
		let answer = this.conditionals.get(current);
		while (answer === undefined) {
			run.push(current);
			const found = this.conditionalEnd(current);
			if (typeof found === "boolean") answer = found;
			else {
				if (found <= current) throw new Error("conditional run failed to advance");
				current = found;
				answer = this.conditionals.get(current);
			}
		}
		for (const item of run) this.conditionals.set(item, answer);
		return answer;
	}

	/** From a `?`: true at its `:`, false where its expression ends first, or the next `?` at its depth. */
	private conditionalEnd(question: number): boolean | number {
		let guard = -1;
		for (let index = question + 1; index < this.tokens.length; index++) {
			if (index <= guard) throw new Error("conditional scan failed to advance");
			guard = index;
			const value = this.value(index);
			if (value === ":") return true;
			if (value === "?") return index;
			if (value === "(" || value === "[" || value === "{") {
				const close = this.matching(index, value, value === "(" ? ")" : value === "[" ? "]" : "}");
				if (close < 0) return false;
				index = close;
			} else if (value !== undefined && CONDITIONAL_ENDS.has(value)) {
				return false;
			}
		}
		return false;
	}

	/** First token starting past `offset`. */
	private firstTokenAfter(offset: number): number {
		let low = 0;
		let high = this.tokens.length;
		while (low < high) {
			const middle = (low + high) >> 1;
			if ((this.tokens[middle] as Token).startOffset <= offset) low = middle + 1;
			else high = middle;
		}
		return low;
	}

	/**
	 * Each reference, or those at tokens `only` accepts, and into `arities` each type reference's
	 * count of type arguments when it has some.
	 */
	private extractReferences(
		metadata: Map<string, DeclarationMeta>,
		qualified: ReadonlySet<number>,
		arities: Map<string, number>,
		only?: (token: Token) => boolean,
	): Reference[] {
		const declarationOffsets = new Set<number>();
		for (const raw of this.rawDeclarations)
			for (const offset of raw.nameTokenOffsets) declarationOffsets.add(offset);
		const references: Reference[] = [];
		const offsets: number[] = [];
		const added = new Set<string>();
		const add = (token: Token, role: Reference["role"], index = -1, name = token.value): void => {
			const key = `${token.startOffset}:${role}`;
			if (added.has(key)) return;
			added.add(key);
			offsets.push(token.startOffset);
			const count = TYPE_ROLES.has(role) ? this.typeArgumentCount(index) : 0;
			if (count > 0) arities.set(positionKey(token.start), count);
			references.push({
				name,
				range: positionRange(token),
				role,
				qualified: qualified.has(token.startOffset),
				binding: {
					status: "unbound",
					reason: "NotImplemented",
					detail: "C# binding is resolved by the provider index",
				},
			});
		};
		if (only === undefined)
			for (const item of this.rawImports) add(item.specifierToken, "import", -1, item.specifier);
		for (let index = 0; index < this.tokens.length; index++) {
			const item = this.token(index);
			if (
				!isIdentifier(item) ||
				(only !== undefined && !only(item)) ||
				declarationOffsets.has(item.startOffset) ||
				this.ignoredOffsets.has(item.startOffset)
			)
				continue;
			const word = syntaxValue(item) as string;
			const next = this.nextSignificant(index + 1);
			const nextValue = this.value(next);
			if (word === "typeof" && nextValue === "(") {
				const close = this.matching(next, "(", ")");
				if (close > next) this.addTypeReference(next + 1, close - 1, "typeUse");
				continue;
			}
			if (word === "nameof" && nextValue === "(") {
				const close = this.matching(next, "(", ")");
				// A generic operand names a type; the rest is a read.
				if (close > next) {
					const typeEnd = this.genericOperandEnd(next + 1, close);
					if (typeEnd !== undefined) this.addTypeReference(next + 1, typeEnd, "typeUse");
				}
				continue;
			}
			if (word === "new") {
				this.markNewInstantiation(index);
				continue;
			}
			if (SKIPPED_WORDS.has(word) && !(nextValue === "(" && ["add", "remove"].includes(word))) continue;
			if (BUILTIN_TYPES.has(word)) continue;
			// An alias left of `::` names no value or type; the names right of it read through it.
			if (nextValue === "::") continue;
			const role = this.roleByOffset.get(item.startOffset);
			if (role !== undefined) {
				add(item, role, index);
				continue;
			}
			const previous = this.previousSignificant(index);
			const previousValue = this.value(previous);
			if (word === "this" || word === "base") continue;
			// A qualifier head (`new A.B()`) is not the instantiated type; markNewInstantiation names B.
			if (previousValue === "new" && nextValue !== ".") {
				add(item, "instantiate", index);
				continue;
			}
			if (this.typeTokenIndices.has(index)) {
				add(item, "typeUse", index);
				continue;
			}
			if (
				nextValue === "(" &&
				!["if", "for", "foreach", "while", "switch", "catch", "lock", "using"].includes(word)
			) {
				add(item, "call");
				continue;
			}
			if (
				ASSIGNMENT_WORDS.has(nextValue ?? "") ||
				nextValue === "++" ||
				nextValue === "--" ||
				previousValue === "++" ||
				previousValue === "--"
			) {
				add(item, "write");
				continue;
			}
			add(item, "read");
		}
		const containers = this.containersAt(offsets, metadata);
		return references.map((reference, index) => {
			const container = containers.get(offsets[index] as number);
			return container === undefined ? reference : { ...reference, fromId: container.declaration.symbolId };
		});
	}

	/** Where a `nameof` operand's type portion ends, through its first generic instantiation. */
	protected genericOperandEnd(start: number, end: number): number | undefined {
		let current = this.nextSignificant(start, end);
		while (current >= 0 && current < end) {
			const value = this.value(current);
			if (value === "<") {
				const close = this.listClose(current, end);
				return close < 0 ? undefined : close;
			}
			if (value === "." || value === "::" || this.token(current)?.kind === "identifier") {
				current = this.nextSignificant(current + 1, end);
				continue;
			}
			return undefined;
		}
		return undefined;
	}

	/** `new [alias::] A.B<T>` before `(`, `{` or `[` marks B as instantiate; A, T and the alias stay as they already read. */
	protected markNewInstantiation(newIndex: number): void {
		let cursor = this.nextSignificant(newIndex + 1);
		const joint = this.nextSignificant(cursor + 1);
		if (this.value(joint) === "::") cursor = this.nextSignificant(joint + 1);
		else if (this.value(cursor) === "global") return;
		let lastIdent = -1;
		for (;;) {
			if (!isIdentifier(this.token(cursor))) return;
			lastIdent = cursor;
			const after = this.nextSignificant(cursor + 1);
			if (this.value(after) !== ".") break;
			cursor = this.nextSignificant(after + 1);
		}
		let afterLast = this.nextSignificant(lastIdent + 1);
		if (this.value(afterLast) === "<") {
			const angleClose = this.listClose(afterLast, this.tokens.length);
			if (angleClose < 0) return;
			afterLast = this.nextSignificant(angleClose + 1);
		}
		// A constructor call, an object or collection initializer, or an array creation.
		const afterLastValue = this.value(afterLast);
		if (afterLastValue !== "(" && afterLastValue !== "{" && afterLastValue !== "[") return;
		const target = this.token(lastIdent);
		if (target !== undefined) this.roleByOffset.set(target.startOffset, "instantiate");
	}

	/**
	 * The type arguments a type name at `index` takes; 0 for none. Its list's top-level commas, so a
	 * list an outer `>>` closes counts too. One walk counts every list opening inside it as well.
	 */
	private typeArgumentCount(index: number): number {
		const open = index < 0 ? -1 : this.nextSignificant(index + 1);
		if (this.value(open) !== "<") return 0;
		const known = this.argumentCounts.get(open);
		if (known !== undefined) return known;
		// Each open list reads the walk's depth and groups relative to where it opened.
		const lists: ArgumentList[] = [];
		// Closes the innermost lists while `closes` holds, each with its count, or as none.
		const close = (none: boolean, closes: (list: ArgumentList) => boolean) => {
			for (let list = lists.at(-1); list !== undefined && closes(list); list = lists.at(-1)) {
				this.argumentCounts.set(list.open, none ? 0 : list.count);
				lists.pop();
			}
		};
		let depth = 0;
		let groups = 0;
		for (let current = open; current >= 0; current = this.nextSignificant(current + 1)) {
			const value = this.value(current);
			if (value === "<") lists.push({ open: current, depth: ++depth, groups, count: 1 });
			else if (value === ">" || value === ">>") {
				depth -= value === ">" ? 1 : 2;
				close(false, (list) => list.depth > depth);
			} else if (value === "(" || value === "[") groups++;
			else if (value === ")" || value === "]") {
				// A list with no group of its own open is none; the lists around it read one group fewer.
				close(true, (list) => list.groups === groups);
				groups--;
			} else if (value === ",") {
				const top = lists.at(-1);
				if (top !== undefined && top.depth === depth && top.groups === groups) top.count++;
			}
			// A type argument list holds none of these.
			else if (value === ";" || value === "{" || value === "}" || value === "=") close(true, () => true);
			if (lists.length === 0) break;
		}
		close(true, () => true);
		return this.argumentCounts.get(open) ?? 0;
	}

	/**
	 * Names right of a member operator, or those `only` accepts, by offset, and what stands left of
	 * each; and each name left of one, with the type arguments it takes. One pass: a receiver extends
	 * the receiver of the name before its operator.
	 */
	private memberAccesses(only?: (token: Token) => boolean): {
		qualified: Set<number>;
		receivers: Map<string, Receiver>;
		receiverNames: Map<string, number>;
	} {
		const qualified = new Set<number>();
		const receivers = new Map<string, Receiver>();
		const receiverNames = new Map<string, number>();
		// Every qualified name's receiver by token index, for the chain to extend.
		const chain = new Map<number, Receiver>();
		let operator = -1;
		for (let index = 0; index < this.tokens.length; index++) {
			const item = this.tokens[index] as Token;
			if (isTrivia(item)) continue;
			if (operator >= 0 && isIdentifier(item)) {
				const receiver = this.receiverAt(operator, chain, receiverNames);
				chain.set(index, receiver);
				if (only === undefined || only(item)) {
					qualified.add(item.startOffset);
					receivers.set(positionKey(item.start), receiver);
				}
			}
			operator = item.kind === "punctuation" && MEMBER_OPERATORS.has(item.value) ? index : -1;
		}
		return { qualified, receivers, receiverNames };
	}

	/**
	 * The receiver left of the member operator at `operator`: the name before it, with its type
	 * arguments, added to that name's own receiver. A simple name heads no chain.
	 */
	private receiverAt(
		operator: number,
		chain: ReadonlyMap<number, Receiver>,
		receiverNames: Map<string, number>,
	): Receiver {
		const before = this.previousSignificant(operator);
		const value = this.value(before);
		if (value === "this") return { kind: "this" };
		if (value === "base") return { kind: "base" };
		if (this.value(operator) === "->") return { kind: "other" };
		// An alias opens the path: `global`, a using alias of a namespace, or an extern alias.
		if (this.value(operator) === "::") {
			const alias = this.token(before);
			return isIdentifier(alias)
				? { kind: "path", path: [], qualifier: alias.value, range: positionRange(alias) }
				: { kind: "other" };
		}
		const open = value === ">" || value === ">>" ? this.argumentsEndingAt(before) : -2;
		if (open === -1) return { kind: "other" };
		const nameIndex = open < 0 ? before : this.previousSignificant(open);
		const token = this.token(nameIndex);
		if (!isIdentifier(token) || syntaxValue(token) === "this" || syntaxValue(token) === "base")
			return { kind: "other" };
		const segment = { name: token.value, arity: open < 0 ? 0 : this.typeArgumentCount(nameIndex) };
		receiverNames.set(positionKey(token.start), segment.arity);
		const joint = this.value(this.previousSignificant(nameIndex));
		if (joint !== "." && joint !== "?." && joint !== "::")
			return { kind: "name", name: segment.name, arity: segment.arity, range: positionRange(token) };
		const left = chain.get(nameIndex);
		const range = (start: Range["start"]) => ({ start, end: token.end });
		if (left?.kind === "name")
			return {
				kind: "path",
				path: [{ name: left.name, arity: left.arity }, segment],
				range: range(left.range.start),
			};
		// A chain longer than any type's name is a value's.
		if (left?.kind === "path" && left.path.length < MAX_RECEIVER_NAMES)
			return {
				kind: "path",
				path: [...left.path, segment],
				...defined({ qualifier: left.qualifier }),
				range: range(left.range.start),
			};
		return { kind: "other" };
	}

	/** Where the type argument list closing at `close` opens; -1 when none does. */
	private argumentsEndingAt(close: number): number {
		let depth = 0;
		for (let current = close; current >= 0; current = this.previousSignificant(current)) {
			const value = this.value(current);
			if (value === ">") depth++;
			else if (value === ">>") depth += 2;
			else if (value === "<") depth--;
			else if (value === ";" || value === "{" || value === "}") return -1;
			if (depth < 0) return -1;
			if (depth === 0) return this.listClose(current, close + 1) === close ? current : -1;
		}
		return -1;
	}

	/** The innermost declaration holding each offset, in one sweep. */
	private containersAt(
		offsets: readonly number[],
		metadata: Map<string, DeclarationMeta>,
	): Map<number, DeclarationMeta | undefined> {
		const intervals: Interval<DeclarationMeta>[] = [];
		for (const item of metadata.values()) {
			// A parameter's header is its declaration's.
			const kind = item.declaration.languageKind;
			if (kind === "parameter" || kind === "lambdaParameter") continue;
			const own = item.declarator;
			intervals.push({
				start: own?.startOffset ?? item.startOffset,
				end: own?.endOffset ?? item.endOffset,
				value: item,
			});
		}
		const sweep = new InnermostSweep(intervals);
		const containers = new Map<number, DeclarationMeta | undefined>();
		for (const offset of [...new Set(offsets)].sort((left, right) => left - right))
			containers.set(offset, sweep.at(offset));
		return containers;
	}

	private extractLiterals(metadata: Map<string, DeclarationMeta>): Literal[] {
		const literals: Literal[] = [];
		const containers = this.containersAt(
			this.lexed.literals.map((item) => item.startOffset),
			metadata,
		);
		for (const item of this.lexed.literals) {
			const container = containers.get(item.startOffset);
			const literal: Literal = {
				kind: item.kind === "boolean" ? "boolean" : item.kind === "number" ? "number" : "string",
				value: item.value,
				range: positionRange(item),
				...(item.number === undefined ? {} : { number: item.number }),
				...(container === undefined ? {} : { containerId: container.declaration.symbolId }),
			};
			literals.push(literal);
		}
		return literals;
	}

	/** Raw spans off the lexed stream, so a marker inside a string is never one. */
	private extractComments(): CommentSpan[] {
		return this.lexed.comments.map((item) => ({
			range: positionRange(item),
			text: item.raw,
			codeBefore: this.lexed.trivia.get(item)?.codeBefore ?? false,
			codeAfter: this.lexed.trivia.get(item)?.codeAfter ?? false,
		}));
	}
}
