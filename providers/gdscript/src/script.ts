// Owns one parse of a GDScript file, read once and shared by every extractor.

import { coordinatesOf, type TextCoordinates, type WorkMeter } from "@nyaa-lexicon/protocol";
import { type Blocks, blocksOf } from "./blocks.js";
import { extractGdscript } from "./declarations.js";
import type { ComposeSymbolId, DeclarationFact } from "./parse-model.js";
import { type LexedSource, lexSource } from "./tokens.js";

////////////////////////////////
//  Classes

export class ParsedScript {
	readonly lexed: LexedSource;
	readonly coordinates: TextCoordinates;
	private blocksRead: Blocks | undefined;
	private declarationsRead: DeclarationFact[] | undefined;

	constructor(
		readonly module: string,
		readonly text: string,
		readonly compose: ComposeSymbolId,
		readonly meter?: WorkMeter,
	) {
		this.lexed = lexSource(text);
		this.coordinates = coordinatesOf(text);
	}

	get blocks(): Blocks {
		this.blocksRead ??= blocksOf(this.lexed);
		return this.blocksRead;
	}

	/** Metrics excluded. */
	get declarations(): DeclarationFact[] {
		this.declarationsRead ??= extractGdscript(this);
		return this.declarationsRead;
	}
}
