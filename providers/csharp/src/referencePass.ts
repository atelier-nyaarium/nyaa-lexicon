import { defined, type Range, type Reference } from "@nyaa-lexicon/protocol";
import { CsharpDeclarationPass } from "./declarationPass.js";
import { InnermostSweep, type Interval } from "./innermost.js";
import { type DeclarationMeta, positionKey, type Receiver } from "./model.js";
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

export abstract class CsharpReferencePass extends CsharpDeclarationPass {
	/** Each type argument list's count of arguments, by its `<`; 0 when it is none. */
	private readonly argumentCounts = new Map<number, number>();

	/**
	 * Each reference, or those at tokens `only` accepts, and into `arities` each type reference's
	 * count of type arguments when it has some.
	 */
	protected extractReferences(
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
	protected memberAccesses(only?: (token: Token) => boolean): {
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
			if (this.meter !== undefined) this.meter.steps++;
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
	protected containersAt(
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
