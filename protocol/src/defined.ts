// Building a fact with optional fields under `exactOptionalPropertyTypes`.
//
// The setting forbids assigning `undefined` to an optional property, so composing a fact meant
// spelling `...(x === undefined ? {} : { x })` once per field. Two hundred and fifty-nine sites
// across every provider and core wrote that, which is the repeat this package exists to absorb.
//
// Type-safety is unchanged, not traded away: `defined.types.ts` pins that a missing required field,
// a required field routed through here, and a wrong-typed optional all still fail the compiler,
// exactly as the spread they replace did.

////////////////////////////////
//  Functions & Helpers

/**
 * The same object with its undefined-valued keys absent, so an optional field is missing rather
 * than present and undefined.
 *
 * Every key becomes optional in the result, which is the honest type: whether one survives is a
 * runtime fact about its value. Spread it into a literal that supplies the required fields.
 *
 * WHERE THE LINE IS, since both spellings live side by side. This is for a field whose value IS the
 * thing tested. A field whose value is COMPUTED from it keeps the conditional spread, because the
 * guard is load-bearing there: it decides absence AND narrows the value the computation runs on.
 *
 *     ...defined({ containerId }),                                              // value is the field
 *     ...(id === undefined ? {} : { containerId: repoint(id, range) }),         // guard narrows a call
 */
export function defined<T extends object>(fields: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
	const kept: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(fields)) {
		if (value !== undefined) kept[key] = value;
	}
	return kept as { [K in keyof T]?: Exclude<T[K], undefined> };
}
