import type { CommentSpan, Literal } from "@nyaa-lexicon/protocol";
import type { DeclarationMeta } from "./model.js";
import { CsharpReferencePass } from "./referencePass.js";
import { positionRange } from "./tokens.js";

////////////////////////////////
//  Classes

export abstract class CsharpProjectionPass extends CsharpReferencePass {
	protected extractLiterals(metadata: Map<string, DeclarationMeta>): Literal[] {
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
				...(item.dedented === undefined ? {} : { dedented: item.dedented }),
			};
			literals.push(literal);
		}
		return literals;
	}

	/** Raw spans off the lexed stream, so a marker inside a string is never one. */
	protected extractComments(): CommentSpan[] {
		return this.lexed.comments.map((item) => ({
			range: positionRange(item),
			text: item.raw,
			codeBefore: this.lexed.trivia.get(item)?.codeBefore ?? false,
			codeAfter: this.lexed.trivia.get(item)?.codeAfter ?? false,
		}));
	}
}
