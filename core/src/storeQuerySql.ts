import type { ReferenceRole } from "@nyaa-lexicon/protocol";
import { searchTerm } from "./search.js";
import type { CommentFilter, DocFilter, HiddenModules, LiteralFilter } from "./store.js";

/** Classifies use vs mention. */
const ROLE_CLASS: Readonly<Record<ReferenceRole, "use" | "mention">> = {
	call: "use",
	read: "use",
	write: "use",
	extends: "use",
	implements: "use",
	instantiate: "use",
	typeUse: "use",
	import: "mention",
	export: "mention",
};

/** SQL form of ROLE_CLASS. */
function useSql(alias: string): string {
	const uses = Object.entries(ROLE_CLASS).filter(([, kind]) => kind === "use");
	return `${alias}.role IN (${uses.map(([role]) => `'${role}'`).join(", ")})`;
}

/** 1 for a module under a test directory or named as a test, so a name search lists source first. */
const TEST_PATH = `(module LIKE '%__tests__/%' OR module LIKE '%.test.%' OR module LIKE '%.spec.%'
 OR module LIKE 'test/%' OR module LIKE '%/test/%' OR module LIKE 'tests/%' OR module LIKE '%/tests/%')`;

/** 1 for a module under a dependency directory, so a name search lists the workspace's own code first. */
const VENDOR_PATH = `(module LIKE 'node_modules/%' OR module LIKE '%/node_modules/%' OR module LIKE 'vendor/%'
 OR module LIKE '%/vendor/%' OR module LIKE 'third_party/%' OR module LIKE '%/third_party/%')`;

/** Excludes hidden modules, bound as a JSON list. */
function leaveOut(
	hidden: HiddenModules,
	where: string[],
	values: Array<string | number>,
	column: "module" | "l.module" = "module",
): void {
	if (hidden.length === 0) return;
	where.push(`${column} NOT IN (SELECT value FROM json_each(?))`);
	values.push(JSON.stringify(hidden));
}

function literalWhere(filter: LiteralFilter) {
	const where: string[] = [];
	const values: Array<string | number> = [];
	// A key is an inner match: a literal with no container has no name to match.
	const join =
		filter.key === undefined
			? "LEFT JOIN symbols s ON s.symbolId = l.containerId"
			: "JOIN symbols s ON s.symbolId = l.containerId";
	leaveOut(filter.hidden, where, values, "l.module");
	if (filter.value !== undefined) {
		where.push("l.value = ?");
		values.push(filter.value);
	}
	if (filter.kind !== undefined) {
		where.push("l.kind = ?");
		values.push(filter.kind);
	}
	if (filter.low !== undefined || filter.high !== undefined) {
		where.push("l.number IS NOT NULL AND l.number BETWEEN ? AND ?");
		values.push(filter.low ?? Number.NEGATIVE_INFINITY, filter.high ?? Number.POSITIVE_INFINITY);
	}
	if (filter.key !== undefined) {
		where.push("s.name = ?");
		values.push(filter.key);
	}
	if (filter.module !== undefined) under("l.module", filter.module, where, values);
	if (filter.scope?.module !== undefined) {
		where.push("l.containerId >= ? AND l.containerId < ?");
		values.push(filter.scope.low as string, filter.scope.high as string);
	}
	if (filter.scope?.like !== undefined) {
		where.push("l.containerId LIKE ? ESCAPE '\\'");
		values.push(`${filter.scope.head}%${likePattern(filter.scope.like)}%`);
	}
	return { join, clause: where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`, values };
}

/** Escapes what LIKE treats as wildcards, so a search for `100%` is a search for `100%`. */
function likePattern(text: string): string {
	return searchTerm(text).replace(/[%_\\]/g, "\\$&");
}

/** A module path names that file, or every module in that folder. Case-sensitive, as LIKE is not. */
function under(column: string, path: string, where: string[], values: Array<string | number>): void {
	where.push(`(${column} = ? OR substr(${column}, 1, length(?)) = ?)`);
	values.push(path, `${path}/`, `${path}/`);
}

/** Source order, and by column too: two comments can share a line. */
const COMMENT_ORDER = "ORDER BY module, startLine, startChar";

/** One place builds the clause, so a count and its page can never disagree about what matched. */
function commentWhere(filter: CommentFilter, text?: string): { clause: string; values: Array<string | number> } {
	const where: string[] = [];
	const values: Array<string | number> = [];
	leaveOut(filter.hidden, where, values);
	if (text !== undefined) {
		where.push("normalized LIKE ? ESCAPE '\\'");
		values.push(`%${likePattern(text)}%`);
	}
	if (filter.form !== undefined) {
		where.push("form = ?");
		values.push(filter.form);
	}
	if (filter.module !== undefined) under("module", filter.module, where, values);
	return { clause: where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`, values };
}

/** Document order, and by column too: a range can start where the previous one ended. */
const DOC_ORDER = "ORDER BY module, startLine, startChar";

/** One place builds the clause, so a count and its page can never disagree about what matched. */
function docWhere(filter: DocFilter, text?: string): { clause: string; values: Array<string | number> } {
	const where: string[] = [];
	const values: Array<string | number> = [];
	leaveOut(filter.hidden, where, values);
	if (text !== undefined) {
		where.push("normalized LIKE ? ESCAPE '\\'");
		values.push(`%${likePattern(text)}%`);
	}
	if (filter.fenced !== undefined) {
		where.push("fenced = ?");
		values.push(filter.fenced ? 1 : 0);
	}
	if (filter.module !== undefined) under("module", filter.module, where, values);
	return { clause: where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`, values };
}

function importWhere(hidden: HiddenModules, specifier?: string): { clause: string; values: Array<string | number> } {
	const where: string[] = [];
	const values: Array<string | number> = [];
	leaveOut(hidden, where, values);
	if (specifier !== undefined) {
		where.push("specifier LIKE ? ESCAPE '\\'");
		values.push(`%${likePattern(specifier)}%`);
	}
	return { clause: where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`, values };
}

function sharedWhere(hidden: HiddenModules): { clause: string; values: Array<string | number> } {
	const where: string[] = [];
	const values: Array<string | number> = [];
	leaveOut(hidden, where, values);
	return { clause: where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`, values };
}

export {
	COMMENT_ORDER,
	commentWhere,
	DOC_ORDER,
	docWhere,
	importWhere,
	leaveOut,
	likePattern,
	literalWhere,
	sharedWhere,
	TEST_PATH,
	under,
	useSql,
	VENDOR_PATH,
};
