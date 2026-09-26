// The one schema for a module named on the wire.

import { z } from "zod";
import { normalizeModulePath } from "./symbolId.js";

/**
 * Normalizes to the index's module key (NFC, forward slashes, no `.` or empty segments); refuses
 * an absolute, escaping, or control-character path. A transform: `./src/a.ts` or an NFD name is served.
 */
export const ModulePathSchema = z
	.string()
	.min(1)
	.transform((raw, context) => {
		try {
			return normalizeModulePath(raw);
		} catch (error) {
			context.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
			return z.NEVER;
		}
	})
	.meta({ id: "ModulePath" });
