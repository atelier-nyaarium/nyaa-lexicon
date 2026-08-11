////////////////////////////////
//  Classification

/** Declaration files are already the compiler-authorized package surface. */
export function isDeclarationModule(module: string): boolean {
	return /\.d\.(?:ts|mts|cts)$/.test(module);
}

/** Minifiers collapse lines by orders of magnitude, unlike ordinary compiler output. */
export function isLikelyBundle(module: string, text: string): boolean {
	if (/\.min\.(?:js|mjs|cjs)$/.test(module)) return true;
	if (text.length < 2_000) return false;

	let lines = 1;
	let current = 0;
	let longest = 0;
	for (let index = 0; index < text.length; index++) {
		if (text.charCodeAt(index) === 10) {
			longest = Math.max(longest, current);
			current = 0;
			lines += 1;
		} else {
			current += 1;
		}
	}
	longest = Math.max(longest, current);
	return longest >= 1_000 && text.length / lines >= 500;
}

/** The provider mirrors core glob semantics without depending on the core package. */
export function surfaceGlobMatches(glob: string, module: string): boolean {
	let out = "";
	for (let index = 0; index < glob.length; index++) {
		const character = glob[index] as string;
		if (character === "/" && glob[index + 1] === "*" && glob[index + 2] === "*") {
			if (glob[index + 3] === "/") {
				out += "/(?:.*/)?";
				index += 3;
				continue;
			}
			out += "(?:/.*)?";
			index += 2;
			continue;
		}
		if (character === "*") {
			if (glob[index + 1] === "*") {
				out += glob[index + 2] === "/" ? "(?:.*/)?" : ".*";
				index += glob[index + 2] === "/" ? 2 : 1;
				continue;
			}
			out += "[^/]*";
			continue;
		}
		out += character.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${out}$`).test(module);
}

/** Runtime-root imports can map into an explicitly named bundle directory without a framework rule. */
export function configuredSurfaceCandidates(specifier: string, globs: string[]): string[] {
	if (!specifier.startsWith("/")) return [];
	const clean = specifier.slice(1).split(/[?#]/, 1)[0] ?? "";
	const specifierParts = clean.split("/").filter(Boolean);
	if (specifierParts.length === 0) return [];

	const candidates = new Set<string>();
	for (const glob of globs) {
		const normalized = glob.replace(/^\.\//, "");
		const wildcard = normalized.search(/[*?]/);
		if (wildcard === -1) {
			if (surfaceGlobMatches(normalized, clean) || normalized.endsWith(`/${clean}`)) candidates.add(normalized);
			continue;
		}

		const prefix = normalized.slice(0, wildcard).replace(/\/$/, "");
		const directory = prefix.includes("/") ? prefix : "";
		const directoryParts = directory.split("/").filter(Boolean);
		let overlap = Math.min(directoryParts.length, specifierParts.length);
		while (overlap > 0 && directoryParts.slice(-overlap).join("/") !== specifierParts.slice(0, overlap).join("/")) {
			overlap -= 1;
		}
		const candidate = [...directoryParts.slice(0, directoryParts.length - overlap), ...specifierParts].join("/");
		if (surfaceGlobMatches(normalized, candidate)) candidates.add(candidate);
	}
	return [...candidates];
}
