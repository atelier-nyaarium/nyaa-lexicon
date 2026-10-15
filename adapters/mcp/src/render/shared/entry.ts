import type { EntryHow } from "./types.js";

const ENTRY_HOW: Record<EntryHow, string> = {
	main: "the runtime calls its main",
	guardedMain: "runs under a run-as-program guard",
	topLevel: "runs statements on load",
};

export { ENTRY_HOW };
