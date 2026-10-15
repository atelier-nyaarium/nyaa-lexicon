import type { z } from "zod";
import type { ConformanceFixtureSchema } from "./types.js";

type ConformanceFixture = z.infer<typeof ConformanceFixtureSchema>;

export type { ConformanceFixture };

////////////////////////////////
//  Constants

/**
 * Case and fixture fields that state no expectation. Everything else earns a parse.
 *
 * Exported so one residue can hold it against both schemas: a field in neither this set nor the
 * checker's table is classified by nobody, and silently earns a parse it may not want.
 */
export const CASE_METADATA = new Set([
	"id",
	"tier",
	"about",
	"fixtures",
	"semanticForm",
	"applicableLanguages",
	"files",
	"subject",
	"discovery",
]);

////////////////////////////////
//  Functions & Helpers

/** Content hash stand-in. The suite only needs it to be stable per text, not cryptographic. */
function hashOf(text: string): string {
	let h = 5381;
	for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
	return `h${(h >>> 0).toString(16)}`;
}

export { hashOf };
