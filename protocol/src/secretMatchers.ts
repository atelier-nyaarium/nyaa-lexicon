// Import-free matcher grammar shared by schema, judge, and decision.

////////////////////////////////
//  Interfaces & Types

/** Matcher kind, path, and expected value. */
export type ParsedMatcher =
	| { kind: "file" }
	| { kind: "document"; path: readonly string[]; expect: string }
	| { kind: "key"; path: readonly string[] };

export interface MatcherIssue {
	message: string;
	path: (string | number)[];
}

////////////////////////////////
//  Functions & Helpers

export function isMatcherMap(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Splits paths; `*` is key-only. */
function pathParts(path: string, wildcards: boolean): string[] | null {
	if (path.length === 0) return null;
	const parts = path.split(".");
	for (const part of parts) {
		if (part.length === 0 || part.startsWith("@") || part.includes("=")) return null;
		if (part.includes("*") && (!wildcards || part !== "*")) return null;
	}
	return parts;
}

/** Parsed matcher, or null. */
export function parseMatcher(matcher: string): ParsedMatcher | null {
	if (matcher === "@untracked") return { kind: "file" };
	if (matcher.startsWith("@")) return null;
	const equals = matcher.indexOf("=");
	if (equals >= 0) {
		const path = pathParts(matcher.slice(0, equals), false);
		return path === null ? null : { kind: "document", path, expect: matcher.slice(equals + 1) };
	}
	const path = pathParts(matcher, true);
	return path === null ? null : { kind: "key", path };
}

/** Validation errors; `@untracked` belongs only in a glob's rule map. */
export function validateMatcherMap(
	matchers: Record<string, unknown>,
	path: (string | number)[],
	allowFileCheck: boolean,
): MatcherIssue[] {
	const issues: MatcherIssue[] = [];
	for (const [matcher, value] of Object.entries(matchers)) {
		const parsed = parseMatcher(matcher);
		if (parsed === null || (parsed.kind === "file" && !allowFileCheck)) {
			issues.push({ message: "unknown secret matcher", path: [...path, matcher] });
			continue;
		}
		if (parsed.kind === "document" && !isMatcherMap(value)) {
			issues.push({ message: "document checks need nested matchers", path: [...path, matcher] });
			continue;
		}
		if (isMatcherMap(value)) issues.push(...validateMatcherMap(value, [...path, matcher], false));
	}
	return issues;
}
