import { type Declaration, defined, type FileRole, type Metrics, type Range } from "@nyaa-lexicon/protocol";
import { InnermostSweep, type Interval } from "./innermost.js";
import type { DeclarationMeta, RawDeclaration, Scope } from "./model.js";
import type { CsharpParseContext } from "./parseContext.js";
import type { Token } from "./tokens.js";
import { isIdentifier, LAMBDA_ATTRIBUTE_CONTEXT, MODIFIERS, STATEMENT_BOUNDARY, syntaxValue } from "./words.js";

////////////////////////////////
//  Constants

const BRANCH_WORDS: ReadonlySet<string> = new Set(["if", "for", "foreach", "while", "catch", "case", "&&", "||", "??"]);

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

////////////////////////////////
//  Classes

export class CsharpDeclarationPass {
	constructor(private readonly context: CsharpParseContext) {}

	/** Whether each `?` asked about opens a conditional. */
	private readonly conditionals = new Map<number, boolean>();

	public fileRole(declarations: Declaration[], metadata: Map<string, DeclarationMeta>): FileRole {
		const main = declarations.find((declaration) => {
			if (declaration.kind !== "method" || declaration.name !== "Main") return false;
			return metadata.get(declaration.symbolId)?.isStatic === true;
		});
		if (main !== undefined) return { kind: "entry", how: "main", symbolId: main.symbolId };
		if (this.context.recorder.hasSkippedFileScope()) return { kind: "unknown", reason: "NotImplemented" };
		return { kind: "library" };
	}

	/** Statement-boundary runs are attributes only inside method-shaped bodies. At expression starts,
	 * only runs before lambdas, anonymous methods, or their parameter lists are attributes.
	 */
	public scanNestedAttributes(metadata: Map<string, DeclarationMeta>): void {
		const end = this.context.tokenStream.tokens.length;
		const bodies = new InnermostSweep(this.runningBodyRanges(metadata));
		for (let current = 0; current < end; current++) {
			if (this.context.tokenStream.value(current) !== "[") continue;
			const previous = this.context.tokenStream.previousSignificant(current);
			const previousValue = this.context.tokenStream.value(previous);
			if (previousValue === undefined) continue;
			const token = this.context.tokenStream.token(current) as Token;
			const boundary = STATEMENT_BOUNDARY.has(previousValue) && bodies.at(token.startOffset) !== undefined;
			const anonymousMethodParameter = previousValue === "(" && this.precededByDelegateKeyword(previous);
			if (!boundary && !anonymousMethodParameter && !LAMBDA_ATTRIBUTE_CONTEXT.has(previousValue)) continue;
			const after = this.context.attributes.bracketedSectionsEnd(current, end);
			if (after === current) continue;
			const verified = anonymousMethodParameter
				? true
				: boundary
					? this.looksLikeLocalFunctionSignature(after, end)
					: this.looksLikeLambdaSignature(after, end);
			if (!verified) continue;
			let mark = current;
			while (mark < after) {
				const section = this.context.attributes.attributeSectionAt(mark, end);
				if (section === undefined || section.close < 0) break;
				mark = section.close + 1;
			}
		}
	}

	protected looksLikeLambdaSignature(index: number, end: number): boolean {
		let current = this.context.tokenStream.nextSignificant(index, end);
		while (
			this.context.tokenStream.value(current) === "static" ||
			this.context.tokenStream.value(current) === "async"
		) {
			current = this.context.tokenStream.nextSignificant(current + 1, end);
		}
		if (this.context.tokenStream.value(current) === "delegate") {
			const afterKeyword = this.context.tokenStream.nextSignificant(current + 1, end);
			if (this.context.tokenStream.value(afterKeyword) !== "(")
				return this.context.tokenStream.value(afterKeyword) === "{";
			const close = this.context.tokenStream.matching(afterKeyword, "(", ")", end);
			return (
				close >= 0 &&
				this.context.tokenStream.value(this.context.tokenStream.nextSignificant(close + 1, end)) === "{"
			);
		}
		if (this.context.tokenStream.value(current) === "(") {
			const close = this.context.tokenStream.matching(current, "(", ")", end);
			return (
				close >= 0 &&
				this.context.tokenStream.value(this.context.tokenStream.nextSignificant(close + 1, end)) === "=>"
			);
		}
		return (
			isIdentifier(this.context.tokenStream.token(current)) &&
			this.context.tokenStream.value(this.context.tokenStream.nextSignificant(current + 1, end)) === "=>"
		);
	}

	/** Whether `(` opens an anonymous method's own parameter list. */
	protected precededByDelegateKeyword(parenIndex: number): boolean {
		let current = this.context.tokenStream.previousSignificant(parenIndex);
		while (
			this.context.tokenStream.value(current) === "static" ||
			this.context.tokenStream.value(current) === "async"
		) {
			current = this.context.tokenStream.previousSignificant(current);
		}
		return this.context.tokenStream.value(current) === "delegate";
	}

	/** Whether a local function signature follows, never a bare call. */
	protected looksLikeLocalFunctionSignature(index: number, end: number): boolean {
		let current = this.context.tokenStream.nextSignificant(index, end);
		while (
			isIdentifier(this.context.tokenStream.token(current)) &&
			MODIFIERS.has(this.context.tokenStream.value(current) ?? "")
		) {
			current = this.context.tokenStream.nextSignificant(current + 1, end);
		}
		let sawType = false;
		for (;;) {
			if (!isIdentifier(this.context.tokenStream.token(current))) return false;
			current = this.context.tokenStream.nextSignificant(current + 1, end);
			while (current >= 0 && current < end) {
				const value = this.context.tokenStream.value(current);
				if (value === "<") {
					const close = this.context.typeReader.listClose(current, end);
					if (close < 0) return false;
					current = this.context.tokenStream.nextSignificant(close + 1, end);
					continue;
				}
				if (value === "[") {
					const close = this.context.tokenStream.matching(current, "[", "]", end);
					if (close < 0) return false;
					current = this.context.tokenStream.nextSignificant(close + 1, end);
					continue;
				}
				if (value === "?" || value === "." || value === "::") {
					current = this.context.tokenStream.nextSignificant(current + 1, end);
					continue;
				}
				break;
			}
			if (this.context.tokenStream.value(current) === "(") {
				if (!sawType) return false;
				const close = this.context.tokenStream.matching(current, "(", ")", end);
				if (close < 0) return false;
				const after = this.context.tokenStream.value(this.context.tokenStream.nextSignificant(close + 1, end));
				return after === "{" || after === "=>";
			}
			sawType = true;
		}
	}

	/** Body spans a local function could sit among. */
	private runningBodyRanges(metadata: Map<string, DeclarationMeta>): Interval<true>[] {
		const ranges: Interval<true>[] = this.context.recorder
			.accessorBodyRangesSnapshot()
			.map((range) => ({ ...range, value: true }));
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
		for (const raw of this.context.recorder.declarations()) {
			const count = arity.get(raw) ?? 0;
			if (raw.descriptor?.kind === "type" && raw.descriptor.disambiguator === undefined && count > 0)
				raw.descriptor = { ...raw.descriptor, disambiguator: String(count) };
		}
		const order = new Map(this.context.recorder.declarations().map((raw, index) => [raw, index]));
		const groups = new Map<string, RawDeclaration[]>();
		for (const raw of this.context.recorder.declarations()) {
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
		for (const raw of this.context.recorder.declarations())
			if (raw.kind === "typeParameter" && raw.parent !== undefined)
				arity.set(raw.parent, (arity.get(raw.parent) ?? 0) + 1);
		return arity;
	}

	public finalizeDeclarations(): { declarations: Declaration[]; metadata: Map<string, DeclarationMeta> } {
		const arity = this.arities();
		this.separateSiblings(arity);
		const cache = new Map<RawDeclaration, string>();
		const declarations: Declaration[] = [];
		const metadata = new Map<string, DeclarationMeta>();
		const bodies = this.walkBodies();
		for (const raw of this.context.recorder.declarations()) {
			const symbolId = this.context.recorder.pathFor(raw, cache);
			const containerId = raw.parent === undefined ? undefined : this.context.recorder.pathFor(raw.parent, cache);
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
				namespaceName: this.context.recorder.namespaceName(raw.parent),
				typePath: this.context.recorder.typePath(raw.parent, arity),
				...defined({ parentId: containerId }),
				...defined({
					typeText: raw.typeText,
					typeSegments: raw.typeSegments,
					typeQualifier: raw.typeQualifier,
					typeComposed: raw.typeComposed,
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
		const last = this.context.tokenStream.tokens.length - 1;
		const from = this.context.tokenStream.token(Math.min(last, scope.from)) as Token;
		const to = this.context.tokenStream.token(Math.min(last, Math.max(scope.from, scope.to))) as Token;
		return { start: from.start, end: to.end };
	}

	/** Every body's walk, inner bodies first, so each token is walked once however deep bodies nest. */
	private walkBodies(): Map<RawDeclaration, BodyWalk> {
		const bodies: { raw: RawDeclaration; first: number; stop: number }[] = [];
		for (const raw of this.context.recorder.declarations()) {
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
			const item = this.context.tokenStream.tokens[index] as Token;
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
		for (let index = question + 1; index < this.context.tokenStream.tokens.length; index++) {
			if (index <= guard) throw new Error("conditional scan failed to advance");
			guard = index;
			const value = this.context.tokenStream.value(index);
			if (value === ":") return true;
			if (value === "?") return index;
			if (value === "(" || value === "[" || value === "{") {
				const close = this.context.tokenStream.matching(
					index,
					value,
					value === "(" ? ")" : value === "[" ? "]" : "}",
				);
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
		let high = this.context.tokenStream.tokens.length;
		while (low < high) {
			const middle = (low + high) >> 1;
			if ((this.context.tokenStream.tokens[middle] as Token).startOffset <= offset) low = middle + 1;
			else high = middle;
		}
		return low;
	}
}
