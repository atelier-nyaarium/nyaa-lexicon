// Which modules a search must not read. One matcher, so the daemon's filter and a client's own
// disclosure check cannot disagree about a path.

import { z } from "zod";
import { ModulePathSchema } from "./modulePath.js";
import { normalizeModulePath } from "./symbolId.js";

////////////////////////////////
//  Schemas

const Glob = z.string().min(1).max(256).meta({ id: "Glob" });

/** Hidden when `hide` matches it and neither `keep` nor `allow` names it. */
export const ModuleExclusionSchema = z
	.object({
		/** `lexicon.json`'s glob grammar, matched case-insensitively. */
		hide: z.array(Glob).min(1).max(64),
		/** Globs carved back out of `hide`, e.g. `**\/.env.example`. */
		keep: z.array(Glob).max(64).optional(),
		/** Exact modules shown anyway, compared case-sensitively. */
		allow: z.array(ModulePathSchema).max(512).optional(),
	})
	.meta({ id: "ModuleExclusion" });

export type ModuleExclusion = z.infer<typeof ModuleExclusionSchema>;

////////////////////////////////
//  Functions & Helpers

/**
 * `**` crosses directory separators, `*` does not (`src/*.ts` vs `src/**\/*.ts`).
 * Everything else is escaped, so a dot matches a dot, not any character.
 */
export function globToRegExp(glob: string, flags?: "i"): RegExp {
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const char = glob[i] as string;

		// The separator beside `**` joins it: `dist/**` matches `dist`; `a/**/b` matches `a/b`.
		if (char === "/" && glob[i + 1] === "*" && glob[i + 2] === "*") {
			if (glob[i + 3] === "/") {
				out += "/(?:.*/)?";
				i += 3;
				continue;
			}
			out += "(?:/.*)?";
			i += 2;
			continue;
		}

		if (char === "*") {
			if (glob[i + 1] === "*") {
				out += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
				i += glob[i + 2] === "/" ? 2 : 1;
				continue;
			}
			out += "[^/]*";
			continue;
		}
		out += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${out}$`, flags);
}

/** The module key, or null for a path the id grammar cannot spell. */
function keyOf(module: string): string | null {
	try {
		return normalizeModulePath(module);
	} catch {
		return null;
	}
}

/** Whether a module is hidden. A path the id grammar cannot spell is hidden. */
export function compileExclusion(exclusion: ModuleExclusion): (module: string) => boolean {
	const hide = exclusion.hide.map((glob) => globToRegExp(glob, "i"));
	const keep = (exclusion.keep ?? []).map((glob) => globToRegExp(glob, "i"));
	const allow = new Set((exclusion.allow ?? []).map(keyOf).filter((key) => key !== null));
	return (module) => {
		const key = keyOf(module);
		if (key === null) return true;
		return hide.some((glob) => glob.test(key)) && !keep.some((glob) => glob.test(key)) && !allow.has(key);
	};
}
