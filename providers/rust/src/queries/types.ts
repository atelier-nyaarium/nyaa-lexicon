import { defined, parseSymbolId, type Range, type TypeInfo, type UnknownReason } from "@nyaa-lexicon/protocol";
import type { ParsedFile } from "../model.js";
import { isRustTypeKind } from "../vocabulary.js";
import { contains } from "./bindings.js";
import { LANGUAGE, RustQueryService } from "./context.js";

function unknown(reason: UnknownReason, detail: string): TypeInfo {
	return { status: "unknown", reason, detail };
}

export class RustTypeQueryService extends RustQueryService {
	typeOf(params: { symbolId: string } | { module: string; range: Range }): TypeInfo {
		if ("symbolId" in params) return this.typeOfSymbol(params.symbolId);
		const facts = this.factsForModule(params.module);
		if (facts === null) return unknown("NotIndexed", "module is not indexed");
		const rawDeclaration = facts.rawDeclarations.find(
			(candidate) =>
				contains(candidate.declaration.selectionRange ?? candidate.declaration.range, params.range.start) ||
				contains(candidate.declaration.range, params.range.start),
		);
		if (rawDeclaration !== undefined) return this.typeAnswer(facts, rawDeclaration.declaration.symbolId);
		const rawReference = facts.rawReferences.find((candidate) =>
			contains(candidate.reference.range, params.range.start),
		);
		if (rawReference?.reference.binding.status === "bound")
			return this.typeOfSymbol(rawReference.reference.binding.symbolId);
		return unknown("NotImplemented", "no declared or literal type matches the requested range");
	}

	private typeOfSymbol(symbolId: string): TypeInfo {
		const parsed = parseSymbolId(symbolId);
		if (parsed === null || parsed.language !== LANGUAGE)
			return unknown("ParseError", "the symbol id is not a Rust workspace id");
		const facts = this.factsForModule(parsed.module);
		if (facts === null) return unknown("NotIndexed", "the symbol id module is not indexed");
		return this.typeAnswer(facts, symbolId);
	}

	private typeAnswer(facts: ParsedFile, symbolId: string): TypeInfo {
		const answer = facts.typeAnswers.get(symbolId);
		if (answer === undefined)
			return unknown("NotImplemented", "no annotation or literal initializer establishes a type");
		if (answer.status === "unknown")
			return unknown(
				answer.reason ?? "NotImplemented",
				answer.detail ?? "type inference did not establish a type",
			);
		if (answer.status === "inferred")
			return {
				status: "inferred",
				display: answer.display ?? "unknown",
				basis: answer.basis ?? "literal initializer",
			};
		const display = answer.display ?? "unknown";
		const typeSymbol = answer.typeName === undefined ? undefined : this.resolveTypeSymbol(facts, answer.typeName);
		return {
			status: "known",
			display,
			...defined({ symbolId: typeSymbol }),
			provenance: "declared",
		};
	}

	private resolveTypeSymbol(facts: ParsedFile, name: string): string | undefined {
		if (
			[
				"bool",
				"char",
				"str",
				"u8",
				"u16",
				"u32",
				"u64",
				"u128",
				"usize",
				"i8",
				"i16",
				"i32",
				"i64",
				"i128",
				"isize",
				"f32",
				"f64",
				"Self",
				"self",
			].includes(name)
		)
			return undefined;
		const local = facts.rawDeclarations.find(
			(candidate) => candidate.declaration.name === name && isRustTypeKind(candidate.declaration.kind),
		);
		if (local !== undefined) return local.declaration.symbolId;
		const placed = this.scopes.place(facts, [name], { containerId: undefined, offset: -1 });
		return placed?.kind === "type" ? placed.raw?.declaration.symbolId : undefined;
	}
}
