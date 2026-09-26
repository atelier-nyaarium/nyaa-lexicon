// A start tag as a signature, for every markup reader.

import { type OffsetRange, renderHeader } from "@nyaa-lexicon/protocol";

/** Cut so a value of megabytes does not ride along. */
const SIGNATURE_CAP = 160;

/** The tag on one line with its attribute values as written, capped. */
export function startTagSignature(
	text: string,
	start: number,
	end: number,
	values: readonly OffsetRange[],
): string | undefined {
	const tag = renderHeader(text, { start, end, verbatim: values });
	if (tag === undefined) return undefined;
	return tag.length > SIGNATURE_CAP ? `${tag.slice(0, SIGNATURE_CAP)}...` : tag;
}
