// A declaration's header spans from the helper, handed to the protocol's one renderer.

import {
	type Declaration,
	defined,
	type OffsetRange,
	renderHeader,
	type TextCoordinates,
} from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Interfaces & Types

type Range = Declaration["range"];

/** Where a header sits, as the helper reports it in UTF-16 positions. */
export interface RawHeader {
	/** Rendered before `start`. */
	lead?: Range;
	start: Range["start"];
	end: Range["end"];
	/** Literal containers written as values. */
	folds: Range[];
	/** Comments and line continuations. */
	omit: Range[];
	/** String literals, kept as written. */
	verbatim: Range[];
}

////////////////////////////////
//  Functions & Helpers

function offsetsOf(coordinates: TextCoordinates, ranges: Range[]): OffsetRange[] | undefined {
	const offsets: OffsetRange[] = [];
	for (const range of ranges) {
		const found = coordinates.offsetsForRange(range);
		if (found === undefined) return undefined;
		offsets.push(found);
	}
	return offsets;
}

/** The header on one line; undefined when a span does not address the text. */
export function signatureOf(text: string, coordinates: TextCoordinates, header: RawHeader): string | undefined {
	const start = coordinates.offsetAt(header.start);
	const end = coordinates.offsetAt(header.end);
	const lead = header.lead === undefined ? undefined : coordinates.offsetsForRange(header.lead);
	const folds = offsetsOf(coordinates, header.folds);
	const omit = offsetsOf(coordinates, header.omit);
	const verbatim = offsetsOf(coordinates, header.verbatim);
	const unplaced = header.lead !== undefined && lead === undefined;
	if (start === undefined || end === undefined || unplaced || !folds || !omit || !verbatim) return undefined;
	return renderHeader(text, { ...defined({ lead }), start, end, folds, omit, verbatim });
}
