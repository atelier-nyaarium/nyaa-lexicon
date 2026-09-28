import { defined } from "@nyaa-lexicon/protocol";
import { descriptorKey, type ParseContext } from "./declarations.js";
import { Imports } from "./imports.js";
import type { RustDescriptor } from "./model.js";
import { primitiveTypeForLiteral } from "./numbers.js";
import { isKeyword, isNameToken, isValueToken, type RustToken, TYPE_WORDS, tokenAt } from "./tokens.js";

////////////////////////////////
//  Constants

const RETURN_TYPE_END = new Set(["where", "{"]);

/** Words before a type's name that are not it. */
const TYPE_PREFIX_WORDS = new Set(["const", "mut", "ref", "dyn", "impl", "for", "where"]);

/** Keywords that can start a path. */
const PATH_HEADS = new Set(["Self", "crate", "self", "super"]);

const EQUALS = new Set(["="]);

const PLUS = new Set(["+"]);

////////////////////////////////
//  Functions & Helpers

/** The module a path sits in: its leading namespaces. */
function modulePrefix(descriptors: readonly RustDescriptor[]): RustDescriptor[] {
	const length = descriptors.findIndex((descriptor) => descriptor.kind !== "namespace");
	return descriptors.slice(0, length < 0 ? descriptors.length : length);
}

////////////////////////////////
//  Classes

/** Written types: generic lists and their bounds, type paths, and the declared type a path names. */
export abstract class TypePaths extends Imports {
	/**
	 * The type and const parameters of a generic list opening at `open`, each to its bounds' trait
	 * paths, inline or in a `where` clause before `end`.
	 */
	protected genericsOf(open: number, end: number): Map<string, string[][]> | undefined {
		if (this.angleDeltaAt(open) <= 0) return undefined;
		const close = this.pastGenerics(open, end) - 1;
		const generics = new Map<string, string[][]>();
		for (const [from, to] of this.segments(open + 1, close)) {
			const constant = isValueToken(this.tokens[from], "const");
			const first = constant ? from + 1 : from;
			const name = this.tokens[first];
			if (!isNameToken(name) || isKeyword(name)) continue;
			const bounded = !constant && isValueToken(this.tokens[first + 1], ":");
			generics.set(
				name.value,
				bounded ? this.boundPaths(first + 2, this.topLevelStop(first + 2, to, EQUALS)) : [],
			);
		}
		const where = this.topLevelToken(close + 1, end, "where");
		for (const [from, to] of where < 0 ? [] : this.segments(where + 1, end)) {
			const bounds = generics.get(this.tokens[from]?.value ?? "");
			if (bounds !== undefined && isValueToken(this.tokens[from + 1], ":"))
				bounds.push(...this.boundPaths(from + 2, to));
		}
		return generics;
	}

	/** Each bound's own path in `A + ?Sized + 'a`, the relaxed and lifetime bounds aside. */
	private boundPaths(start: number, end: number): string[][] {
		const paths: string[][] = [];
		for (let from = start; from < end; ) {
			const plus = this.topLevelStop(from, end, PLUS);
			const written = isValueToken(this.tokens[from], "?") ? undefined : this.typePath(from, plus);
			if (written !== undefined) paths.push(this.pathNames(written.first, written.last));
			from = plus + 1;
		}
		return paths;
	}

	protected returnType(
		start: number,
		end: number,
	): { display: string; typeName?: string; path?: string[] } | undefined {
		const arrow = this.topLevelToken(start, end, "->");
		if (arrow < 0 || arrow + 1 >= end) return undefined;
		const typeEnd = this.topLevelStop(arrow + 1, end, RETURN_TYPE_END);
		const display = this.textOfTokens(arrow + 1, typeEnd);
		if (display === "") return undefined;
		return {
			display,
			...defined({
				typeName: this.simpleTypeName(arrow + 1, typeEnd),
				path: this.valueType(arrow + 1, typeEnd),
			}),
		};
	}

	/** The last segment of the first type path, past generics, references and `dyn`. */
	protected typePath(start: number, end: number): { first: number; last: number } | undefined {
		for (let index = this.pastGenerics(start, end); index < end; index++) {
			const token = this.tokens[index];
			if (!isNameToken(token) || TYPE_PREFIX_WORDS.has(token.raw)) continue;
			let last = index;
			while (isValueToken(this.tokens[last + 1], "::") && isNameToken(this.tokens[last + 2]) && last + 2 < end)
				last += 2;
			return { first: index, last };
		}
		return undefined;
	}

	/** A written path's segment names, `first` through `last`. */
	protected pathNames(first: number, last: number): string[] {
		const names: string[] = [];
		for (let index = first; index <= last; index += 2) names.push((this.tokens[index] as RustToken).value);
		return names;
	}

	/** The type a path names from `scope`, a module or a body: the body's items, then its module's, then with `imports`, the context's. */
	protected resolveTypePath(
		names: readonly string[],
		scope: readonly RustDescriptor[],
		imports?: ParseContext,
	): RustDescriptor[] | undefined {
		const module = modulePrefix(scope);
		let frames = module.length === scope.length ? [module] : [[...scope], module];
		let rest = [...names];
		if (rest[0] === "crate") {
			frames = [[]];
			rest = rest.slice(1);
		} else if (rest[0] === "self" || rest[0] === "super") {
			frames = [module];
			if (rest[0] === "self") rest = rest.slice(1);
		}
		while (rest[0] === "super") {
			frames = frames.map((frame) => frame.slice(0, -1));
			rest = rest.slice(1);
		}
		const last = rest.at(-1);
		if (last === undefined) return undefined;
		const tail: RustDescriptor[] = [
			...rest.slice(0, -1).map((name): RustDescriptor => ({ kind: "namespace", name })),
			{ kind: "type", name: last },
		];
		for (const frame of frames) {
			const declared = this.typesByPath.get(descriptorKey([...frame, ...tail]));
			if (declared !== undefined) return declared.descriptorPath;
		}
		if (imports === undefined) return undefined;
		for (const binding of this.importBindings) {
			if (binding.containerId !== imports.containerId) continue;
			const through = binding.glob
				? [...binding.path, ...names]
				: binding.localName === names[0]
					? [...binding.path, ...names.slice(1)]
					: undefined;
			const resolved = through === undefined ? undefined : this.resolveTypePath(through, scope);
			if (resolved !== undefined) return resolved;
		}
		return undefined;
	}

	/** An initializer that is all `Type { .. }`, its path, or all one call `path(..)`, its callee's offset. */
	protected builtPath(start: number, end: number): { literal?: string[]; call?: number } | undefined {
		const head = this.tokens[start];
		if (!isNameToken(head) || (isKeyword(head) && !PATH_HEADS.has(head.raw))) return undefined;
		let last = start;
		while (isValueToken(this.tokens[last + 1], "::") && isNameToken(this.tokens[last + 2])) last += 2;
		const open = last + 1;
		if (this.matchingIndex(open) !== end - 1) return undefined;
		if (isValueToken(this.tokens[open], "{")) return { literal: this.pathNames(start, last) };
		return isValueToken(this.tokens[open], "(")
			? { call: (this.tokens[last] as RustToken).startOffset }
			: undefined;
	}

	/** An annotation's written type path, past references and `dyn`, resolved at binding. */
	protected valueType(start: number, end: number): string[] | undefined {
		let index = start;
		while (
			index < end &&
			(isValueToken(this.tokens[index], "&") ||
				isValueToken(this.tokens[index], "&&") ||
				this.tokens[index]?.kind === "lifetime" ||
				TYPE_PREFIX_WORDS.has(this.tokens[index]?.raw ?? ""))
		)
			index++;
		if (index >= end || !isNameToken(this.tokens[index])) return undefined;
		const written = this.typePath(index, end);
		return written === undefined ? undefined : this.pathNames(written.first, written.last);
	}

	protected simpleTypeName(start: number, end: number): string | undefined {
		for (let index = end - 1; index >= start; index--) {
			const token = this.tokens[index] as RustToken | undefined;
			if (!isNameToken(token) || TYPE_WORDS.has(token.value) || isKeyword(token)) continue;
			return token.value;
		}
		return undefined;
	}

	protected literalInitializer(start: number, end: number): { display: string; basis: string } | undefined {
		if (end - start !== 1) return undefined;
		const token = tokenAt(this.tokens, start);
		if (token === undefined) return undefined;
		const display = primitiveTypeForLiteral(token);
		return display === undefined ? undefined : { display, basis: "literal initializer" };
	}
}
