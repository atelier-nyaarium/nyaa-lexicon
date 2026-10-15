import { defined, type Range, type Reference } from "@nyaa-lexicon/protocol";
import { InnermostSweep, type Interval } from "./innermost.js";
import { type DeclarationMeta, positionKey, type Receiver } from "./model.js";
import type { CsharpParseContext } from "./parseContext.js";
import { positionRange, type Token } from "./tokens.js";
import {
	ASSIGNMENT_WORDS,
	BUILTIN_TYPES,
	isIdentifier,
	isTrivia,
	MEMBER_OPERATORS,
	SKIPPED_WORDS,
	syntaxValue,
} from "./words.js";

////////////////////////////////
//  Constants

/** Roles that name a type. */
const TYPE_ROLES: ReadonlySet<Reference["role"]> = new Set(["typeUse", "extends", "implements", "instantiate"]);

const BASE_ROLES: ReadonlySet<Reference["role"]> = new Set(["extends", "implements"]);

/** Names a receiver chain holds before it reads as a value's. */
const MAX_RECEIVER_NAMES = 64;

////////////////////////////////
//  Interfaces & Types

/** A type argument list a walk has opened: its `<`, the walk's depth and groups there, its count so far. */
interface ArgumentList {
	open: number;
	depth: number;
	groups: number;
	count: number;
}

////////////////////////////////
//  Classes

export class CsharpReferencePass {
	constructor(private readonly context: CsharpParseContext) {}

	/** Each type argument list's count of arguments, by its `<`; 0 when it is none. */
	private readonly argumentCounts = new Map<number, number>();

	/**
	 * Each reference, or those at tokens `only` accepts, and into `arities` each type reference's
	 * count of type arguments when it has some.
	 */
	public extractReferences(
		metadata: Map<string, DeclarationMeta>,
		qualified: ReadonlySet<number>,
		arities: Map<string, number>,
		only?: (token: Token) => boolean,
	): Reference[] {
		const declarationOffsets = new Set<number>();
		for (const raw of this.context.recorder.declarations())
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
			for (const item of this.context.recorder.imports()) add(item.specifierToken, "import", -1, item.specifier);
		for (let index = 0; index < this.context.tokenStream.tokens.length; index++) {
			const item = this.context.tokenStream.token(index);
			if (
				!isIdentifier(item) ||
				(only !== undefined && !only(item)) ||
				declarationOffsets.has(item.startOffset) ||
				this.context.recorder.isIgnored(item.startOffset)
			)
				continue;
			const word = syntaxValue(item) as string;
			const next = this.context.tokenStream.nextSignificant(index + 1);
			const nextValue = this.context.tokenStream.value(next);
			if (word === "typeof" && nextValue === "(") {
				const close = this.context.tokenStream.matching(next, "(", ")");
				if (close > next) this.context.recorder.addTypeReference(next + 1, close - 1, "typeUse");
				continue;
			}
			if (word === "nameof" && nextValue === "(") {
				const close = this.context.tokenStream.matching(next, "(", ")");
				// A generic operand names a type; the rest is a read.
				if (close > next) {
					const typeEnd = this.genericOperandEnd(next + 1, close);
					if (typeEnd !== undefined) this.context.recorder.addTypeReference(next + 1, typeEnd, "typeUse");
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
			const role = this.context.recorder.roleAt(item.startOffset);
			if (role !== undefined) {
				add(item, role, index);
				continue;
			}
			const previous = this.context.tokenStream.previousSignificant(index);
			const previousValue = this.context.tokenStream.value(previous);
			if (word === "this" || word === "base") continue;
			// A qualifier head (`new A.B()`) is not the instantiated type; markNewInstantiation names B.
			if (previousValue === "new" && nextValue !== ".") {
				add(item, "instantiate", index);
				continue;
			}
			if (this.context.recorder.hasTypeToken(index)) {
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
		let current = this.context.tokenStream.nextSignificant(start, end);
		while (current >= 0 && current < end) {
			const value = this.context.tokenStream.value(current);
			if (value === "<") {
				const close = this.context.typeReader.listClose(current, end);
				return close < 0 ? undefined : close;
			}
			if (value === "." || value === "::" || this.context.tokenStream.token(current)?.kind === "identifier") {
				current = this.context.tokenStream.nextSignificant(current + 1, end);
				continue;
			}
			return undefined;
		}
		return undefined;
	}

	/** `new [alias::] A.B<T>` before `(`, `{` or `[` marks B as instantiate; A, T and the alias stay as they already read. */
	protected markNewInstantiation(newIndex: number): void {
		let cursor = this.context.tokenStream.nextSignificant(newIndex + 1);
		const joint = this.context.tokenStream.nextSignificant(cursor + 1);
		if (this.context.tokenStream.value(joint) === "::")
			cursor = this.context.tokenStream.nextSignificant(joint + 1);
		else if (this.context.tokenStream.value(cursor) === "global") return;
		let lastIdent = -1;
		for (;;) {
			if (!isIdentifier(this.context.tokenStream.token(cursor))) return;
			lastIdent = cursor;
			const after = this.context.tokenStream.nextSignificant(cursor + 1);
			if (this.context.tokenStream.value(after) !== ".") break;
			cursor = this.context.tokenStream.nextSignificant(after + 1);
		}
		let afterLast = this.context.tokenStream.nextSignificant(lastIdent + 1);
		if (this.context.tokenStream.value(afterLast) === "<") {
			const angleClose = this.context.typeReader.listClose(afterLast, this.context.tokenStream.tokens.length);
			if (angleClose < 0) return;
			afterLast = this.context.tokenStream.nextSignificant(angleClose + 1);
		}
		// A constructor call, an object or collection initializer, or an array creation.
		const afterLastValue = this.context.tokenStream.value(afterLast);
		if (afterLastValue !== "(" && afterLastValue !== "{" && afterLastValue !== "[") return;
		const target = this.context.tokenStream.token(lastIdent);
		if (target !== undefined) this.context.recorder.markRole(target.startOffset, "instantiate");
	}

	/**
	 * The type arguments a type name at `index` takes; 0 for none. Its list's top-level commas, so a
	 * list an outer `>>` closes counts too. One walk counts every list opening inside it as well.
	 */
	private typeArgumentCount(index: number): number {
		const open = index < 0 ? -1 : this.context.tokenStream.nextSignificant(index + 1);
		if (this.context.tokenStream.value(open) !== "<") return 0;
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
		for (let current = open; current >= 0; current = this.context.tokenStream.nextSignificant(current + 1)) {
			const value = this.context.tokenStream.value(current);
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
	public memberAccesses(only?: (token: Token) => boolean): {
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
		for (let index = 0; index < this.context.tokenStream.tokens.length; index++) {
			if (this.context.meter !== undefined) this.context.meter.steps++;
			const item = this.context.tokenStream.tokens[index] as Token;
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
		const before = this.context.tokenStream.previousSignificant(operator);
		const value = this.context.tokenStream.value(before);
		if (value === "this") return { kind: "this" };
		if (value === "base") return { kind: "base" };
		if (this.context.tokenStream.value(operator) === "->") return { kind: "other" };
		// An alias opens the path: `global`, a using alias of a namespace, or an extern alias.
		if (this.context.tokenStream.value(operator) === "::") {
			const alias = this.context.tokenStream.token(before);
			return isIdentifier(alias)
				? { kind: "path", path: [], qualifier: alias.value, range: positionRange(alias) }
				: { kind: "other" };
		}
		const open = value === ">" || value === ">>" ? this.argumentsEndingAt(before) : -2;
		if (open === -1) return { kind: "other" };
		const nameIndex = open < 0 ? before : this.context.tokenStream.previousSignificant(open);
		const token = this.context.tokenStream.token(nameIndex);
		if (!isIdentifier(token) || syntaxValue(token) === "this" || syntaxValue(token) === "base")
			return { kind: "other" };
		const segment = { name: token.value, arity: open < 0 ? 0 : this.typeArgumentCount(nameIndex) };
		receiverNames.set(positionKey(token.start), segment.arity);
		const joint = this.context.tokenStream.value(this.context.tokenStream.previousSignificant(nameIndex));
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
		for (let current = close; current >= 0; current = this.context.tokenStream.previousSignificant(current)) {
			const value = this.context.tokenStream.value(current);
			if (value === ">") depth++;
			else if (value === ">>") depth += 2;
			else if (value === "<") depth--;
			else if (value === ";" || value === "{" || value === "}") return -1;
			if (depth < 0) return -1;
			if (depth === 0) return this.context.typeReader.listClose(current, close + 1) === close ? current : -1;
		}
		return -1;
	}

	/** The innermost declaration holding each offset, in one sweep. */
	public containersAt(
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
}

export { BASE_ROLES };
