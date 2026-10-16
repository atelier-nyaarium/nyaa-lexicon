// Glob grammar for lexicon.json; imports nothing.

////////////////////////////////
//  Functions & Helpers

/**
 * `**` crosses separators; `*` stays within one.
 * Other characters are escaped, so dots match literally.
 */
export function globToRegExp(glob: string, flags?: "i"): RegExp {
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const char = glob[i] as string;

		// Adjacent separators make `**/` optional.
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

/** Expands valid brace groups; null if invalid. */
export function expandSecretGlob(glob: string): string[] | null {
	const remaining = glob.replace(/^(?:\.\/)+/, "");
	if (remaining.length === 0 || remaining.startsWith("/")) return null;
	if (remaining.split("/").some((part) => part === "" || part === "." || part === "..")) return null;
	let expanded = [remaining];
	while (true) {
		const next: string[] = [];
		let found = false;
		for (const pattern of expanded) {
			const open = pattern.indexOf("{");
			const close = pattern.indexOf("}");
			if (open < 0 && close < 0) {
				next.push(pattern);
				continue;
			}
			if (
				open < 0 ||
				close < open ||
				(pattern.indexOf("{", open + 1) >= 0 && pattern.indexOf("{", open + 1) < close)
			)
				return null;
			const choices = pattern.slice(open + 1, close).split(",");
			if (choices.length < 2 || choices.some((choice) => choice.length === 0)) return null;
			found = true;
			for (const choice of choices) next.push(`${pattern.slice(0, open)}${choice}${pattern.slice(close + 1)}`);
		}
		expanded = next;
		if (expanded.length > 256) return null;
		if (!found) {
			return expanded.every(
				(pattern) =>
					pattern.length > 0 &&
					!pattern.startsWith("/") &&
					!pattern.split("/").some((part) => part === "" || part === "." || part === ".."),
			)
				? expanded
				: null;
		}
	}
}
