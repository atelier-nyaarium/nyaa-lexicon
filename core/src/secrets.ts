import type { SecretFormatId } from "@nyaa-lexicon/formats/secret";
import {
	comparePositions,
	composeSymbolId,
	coordinatesOf,
	type Declaration,
	type OffsetRange,
	type Range,
	rangeInRange,
	type ValueStatus,
} from "@nyaa-lexicon/protocol";
import type { SecretDecision, ShownStep } from "@nyaa-lexicon/protocol/secretDecision";
import type { MethodResponse } from "./providerPort.js";
import type { MaskedView } from "./sourceRead.js";

////////////////////////////////
//  Interfaces & Types

type ParseFacts = MethodResponse<"parseFile">;
type DescriptorList = Parameters<typeof composeSymbolId>[0]["descriptors"];

export type SecretDeclaration = Declaration & { valueStatus?: ValueStatus };

/** Visible key location and status. */
export interface ShownRange {
	document: number;
	path: readonly ShownStep[];
	range: Range;
	status: ValueStatus;
}

export interface SecretMask {
	wholeFile: boolean;
	/** Hidden spans, excluding shown keys. */
	spans: readonly Range[];
	/** Extents removed with descendants. */
	omitted: readonly Range[];
	shown: readonly ShownRange[];
}

export type RedactedDecision = Extract<SecretDecision, { kind: "redacted" }>;

////////////////////////////////
//  Constants

/** Marker for each hidden span. */
const REDACTED_MARK = "(redacted)";

////////////////////////////////
//  Masking

export function maskSecretText(text: string, spans: readonly Range[]): string | null {
	const coordinates = coordinatesOf(text);
	const offsets = spans.map((span) => coordinates.offsetsForRange(span));
	if (offsets.some((span) => span === undefined)) return null;
	const units = text.split("");
	for (const span of offsets) {
		if (span === undefined) continue;
		for (let offset = span.start; offset < span.end; offset++) {
			if (units[offset] !== "\n" && units[offset] !== "\r") units[offset] = " ";
		}
	}
	return units.join("");
}

/** Whole-file mask, or null for invalid offsets. */
export function wholeFileMask(text: string): SecretMask | null {
	const full = coordinatesOf(text).rangeAt(0, text.length);
	return full === undefined ? null : { wholeFile: true, spans: [full], omitted: [], shown: [] };
}

/** Decision mask in text coordinates, or null for invalid offsets. */
export function maskForDecision(text: string, decision: RedactedDecision, wholeFile: boolean): SecretMask | null {
	const coordinates = coordinatesOf(text);
	const place = (span: OffsetRange) => coordinates.rangeAt(span.start, span.end);
	const spans = decision.mask.map(place);
	const omitted = decision.omitted.map(place);
	const keys = decision.shown.map((key) => ({ key, range: place(key.key) }));
	if (spans.includes(undefined) || omitted.includes(undefined) || keys.some(({ range }) => range === undefined))
		return null;
	return {
		wholeFile,
		spans: spans as Range[],
		omitted: omitted as Range[],
		shown: keys.map(({ key, range }) => ({
			document: key.document,
			path: key.path,
			range: range as Range,
			status: key.status,
		})),
	};
}

////////////////////////////////
//  Declarations

function descriptorOf(step: ShownStep): DescriptorList[number] {
	return typeof step === "number" ? { kind: "namespace", name: `[${step}]` } : { kind: "term", name: step };
}

/** Key declarations; duplicate IDs keep the last. */
export function secretDeclarations(
	format: SecretFormatId,
	module: string,
	shown: readonly ShownRange[],
	documents: number,
): SecretDeclaration[] {
	const found = new Map<string, SecretDeclaration>();
	for (const key of shown) {
		const name = key.path[key.path.length - 1];
		if (typeof name !== "string") continue;
		const descriptors: DescriptorList = [
			...(documents > 1 ? [{ kind: "namespace" as const, name: `[${key.document}]` }] : []),
			...key.path.map(descriptorOf),
		];
		const owner = key.path.findLastIndex((step, at) => at < key.path.length - 1 && typeof step === "string");
		const symbolId = composeSymbolId({ language: format, module, descriptors });
		const containerId =
			owner < 0
				? undefined
				: composeSymbolId({
						language: format,
						module,
						descriptors: descriptors.slice(0, descriptors.length - (key.path.length - 1 - owner)),
					});
		found.set(symbolId, {
			symbolId,
			kind: "property",
			name,
			range: key.range,
			selectionRange: key.range,
			visibility: "public",
			...(containerId === undefined ? {} : { containerId }),
			valueStatus: key.status,
		});
	}
	return [...found.values()];
}

////////////////////////////////
//  Filtering

function rangeKey(range: Range): string {
	return `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
}

function overlaps(a: Range, b: Range): boolean {
	return comparePositions(a.start, b.end) <= 0 && comparePositions(b.start, a.end) <= 0;
}

function inAny(range: Range, spans: readonly Range[]): boolean {
	return spans.some((span) => rangeInRange(span, range));
}

function touchesAny(range: Range, spans: readonly Range[]): boolean {
	return spans.some((span) => overlaps(range, span));
}

function withoutSignature<T extends Declaration>(declaration: T): Omit<T, "signature"> {
	const { signature: _signature, ...rest } = declaration;
	return rest;
}

function protectedDeclarations(declarations: readonly SecretDeclaration[], mask: SecretMask): SecretDeclaration[] {
	const shown = new Map(mask.shown.map((key) => [rangeKey(key.range), key]));
	return declarations.flatMap((declaration) => {
		const selection = declaration.selectionRange ?? declaration.range;
		if (inAny(selection, mask.omitted)) return [];
		const key = shown.get(rangeKey(selection));
		if (key !== undefined) return [{ ...withoutSignature(declaration), range: selection, valueStatus: key.status }];
		if (inAny(declaration.range, mask.omitted) || inAny(selection, mask.spans)) return [];
		if (touchesAny(declaration.range, mask.spans) || touchesAny(declaration.range, mask.omitted))
			return [withoutSignature(declaration)];
		return [declaration];
	});
}

function insideHidden(range: Range, mask: SecretMask): boolean {
	return touchesAny(range, mask.spans) || touchesAny(range, mask.omitted);
}

function protectedImports(imports: ParseFacts["imports"], mask: SecretMask): ParseFacts["imports"] {
	return imports.flatMap((entry) => {
		const edges = entry.edges.filter((edge) => !insideHidden(edge.span, mask));
		return edges.length === 0 ? [] : [{ ...entry, edges }];
	});
}

/** Removes facts overlapping hidden or omitted spans; clamps shown keys. */
export function protectSecretFacts(facts: ParseFacts, mask: SecretMask): ParseFacts {
	const { allList: _allList, scopeContributions: _scopeContributions, ...base } = facts;
	return {
		...base,
		declarations: protectedDeclarations(facts.declarations, mask),
		references: facts.references.filter((reference) => !insideHidden(reference.range, mask)),
		imports: protectedImports(facts.imports, mask),
		literals: facts.literals.filter((literal) => !insideHidden(literal.range, mask)),
		comments: (facts.comments ?? []).filter((comment) => !insideHidden(comment.range, mask)),
		docs: (facts.docs ?? []).filter((doc) => !insideHidden(doc.range, mask)),
		...(facts.exports === undefined
			? {}
			: { exports: facts.exports.filter((entry) => !insideHidden(entry.span, mask)) }),
	};
}

////////////////////////////////
//  Views

/** Reads hidden spans as markers; null for invalid ranges. */
function redactedSlice(text: string, range: Range, spans: readonly Range[]): string | null {
	const coordinates = coordinatesOf(text);
	const slice = coordinates.offsetsForRange(range);
	if (slice === undefined) return null;
	const hidden = spans.map((span) => coordinates.offsetsForRange(span));
	if (hidden.some((span) => span === undefined)) return null;
	const hiddenUnits = new Uint8Array(text.length);
	const zeroWidth = new Uint8Array(text.length + 1);
	for (const span of hidden) {
		if (span === undefined) continue;
		if (span.start === span.end) zeroWidth[span.start] = 1;
		for (let offset = span.start; offset < span.end; offset++) hiddenUnits[offset] = 1;
	}
	let result = "";
	for (let offset = slice.start; offset <= slice.end; offset++) {
		if (zeroWidth[offset] === 1) result += REDACTED_MARK;
		if (offset === slice.end) break;
		if (hiddenUnits[offset] === 1) {
			if (offset === slice.start || hiddenUnits[offset - 1] !== 1) result += REDACTED_MARK;
			continue;
		}
		result += text[offset];
	}
	return result;
}

/** Collapses hidden spans. */
export function redactedText(text: string, spans: readonly Range[]): string {
	const range = coordinatesOf(text).rangeAt(0, text.length);
	return range === undefined ? REDACTED_MARK : (redactedSlice(text, range, spans) ?? REDACTED_MARK);
}

/** Consumer view with hidden values blanked. */
export function maskedView(allowed: string, hash: string, mask: SecretMask): MaskedView {
	return {
		kind: "masked",
		text: allowed,
		hash,
		hidden: mask.wholeFile || mask.spans.length > 0,
		slice: (range) => redactedSlice(allowed, range, mask.spans),
		touches: (range) => mask.wholeFile || touchesAny(range, mask.spans),
		omits: (range) => inAny(range, mask.omitted),
	};
}
