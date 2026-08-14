// Owns static GDScript path syntax and its source spans.

import type { SourceLine } from "./parse-model.js";

//////// Path syntax

export type PathSyntaxKind = "extends" | "load" | "preload";

export interface PathSyntax {
	kind: PathSyntaxKind;
	path: string;
	pathStart: number;
	literalStart: number;
	literalEnd: number;
	loaderStart: number;
}

const extendsPattern = /^\s*(?:class\s+[\p{L}_][\p{L}\p{M}\p{N}_]*\s+)?extends\s+("|')([^"']+)\1/du;
const loaderPattern = /\b(preload|load)\s*\(\s*(&?)("|')([^"']+)\3/dgu;

export function pathSyntax(line: SourceLine): PathSyntax[] {
	const syntax: PathSyntax[] = [];
	const extendsMatch = extendsPattern.exec(line.text);
	const extendsPath = extendsMatch?.[2];
	const extendsStart = extendsMatch?.indices?.[2]?.[0];
	if (extendsMatch !== null && extendsPath !== undefined && extendsStart !== undefined) {
		syntax.push({
			kind: "extends",
			path: extendsPath,
			pathStart: extendsStart,
			literalStart: extendsStart - 1,
			literalEnd: extendsStart + extendsPath.length + 1,
			loaderStart: -1,
		});
	}
	for (const match of line.text.matchAll(loaderPattern)) {
		const loader = match[1];
		const typedPrefix = match[2];
		const path = match[4];
		const loaderStart = match.indices?.[1]?.[0];
		const quoteStart = match.indices?.[3]?.[0];
		const pathStart = match.indices?.[4]?.[0];
		if (
			loader === undefined ||
			path === undefined ||
			loaderStart === undefined ||
			quoteStart === undefined ||
			pathStart === undefined
		)
			continue;
		if (!line.code.startsWith(loader, loaderStart)) continue;
		syntax.push({
			kind: loader as "load" | "preload",
			path,
			pathStart,
			literalStart: typedPrefix === "&" ? quoteStart - 1 : quoteStart,
			literalEnd: pathStart + path.length + 1,
			loaderStart,
		});
	}
	return syntax;
}
