// Which modules a search must not read. One matcher, so the daemon's filter and a client's own
// disclosure check cannot disagree about a path.

import { z } from "zod";
import { globToRegExp } from "./glob.js";
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
