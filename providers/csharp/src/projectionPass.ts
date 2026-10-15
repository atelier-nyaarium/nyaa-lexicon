import type { CommentSpan, Literal } from "@nyaa-lexicon/protocol";
import type { DeclarationMeta } from "./model.js";
import type { CsharpParseContext } from "./parseContext.js";
import { positionRange } from "./tokens.js";

////////////////////////////////
//  Classes

export class CsharpProjectionPass {
	constructor(private readonly context: CsharpParseContext) {}

	public extractLiterals(metadata: Map<string, DeclarationMeta>): Literal[] {
		const literals: Literal[] = [];
		const containers = this.context.referencePass.containersAt(
			this.context.tokenStream.lexed.literals.map((item) => item.startOffset),
			metadata,
		);
		for (const item of this.context.tokenStream.lexed.literals) {
			const container = containers.get(item.startOffset);
			const literal: Literal = {
				kind: item.kind === "boolean" ? "boolean" : item.kind === "number" ? "number" : "string",
				value: item.value,
				range: positionRange(item),
				...(item.number === undefined ? {} : { number: item.number }),
				...(container === undefined ? {} : { containerId: container.declaration.symbolId }),
				...(item.dedented === undefined ? {} : { dedented: item.dedented }),
			};
			literals.push(literal);
		}
		return literals;
	}

	/** Raw spans off the lexed stream, so a marker inside a string is never one. */
	public extractComments(): CommentSpan[] {
		return this.context.tokenStream.lexed.comments.map((item) => ({
			range: positionRange(item),
			text: item.raw,
			codeBefore: this.context.tokenStream.lexed.trivia.get(item)?.codeBefore ?? false,
			codeAfter: this.context.tokenStream.lexed.trivia.get(item)?.codeAfter ?? false,
		}));
	}
}
