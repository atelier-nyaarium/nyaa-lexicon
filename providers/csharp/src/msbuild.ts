// MSBuild's evaluation, as far as symbols need it: property expansion, simple conditions, and the
// SDK's implicit framework symbols.

import { SourceCursor } from "@nyaa-lexicon/protocol";
import { isIdentifierPart, isIdentifierStart, isNewline, isWhitespace } from "./characters.js";

////////////////////////////////
//  Constants

/** A property reference with no function in it. */
const PROPERTY_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/u;

/** Each family's versions the SDK knows, oldest first; every one up to the target is `_OR_GREATER`. */
const FRAMEWORK_VERSIONS = [
	"1.0",
	"1.1",
	"2.0",
	"3.5",
	"4.0",
	"4.5",
	"4.5.1",
	"4.5.2",
	"4.6",
	"4.6.1",
	"4.6.2",
	"4.7",
	"4.7.1",
	"4.7.2",
	"4.8",
	"4.8.1",
];
const STANDARD_VERSIONS = ["1.0", "1.1", "1.2", "1.3", "1.4", "1.5", "1.6", "2.0", "2.1"];
const CORE_VERSIONS = ["1.0", "1.1", "2.0", "2.1", "2.2", "3.0", "3.1"];
const NET_VERSIONS = ["5.0", "6.0", "7.0", "8.0", "9.0", "10.0"];

/** The Windows platform versions the SDK supports, oldest first. Another platform's come from its workload. */
const WINDOWS_VERSIONS = [
	"7.0",
	"8.0",
	"10.0.17763.0",
	"10.0.18362.0",
	"10.0.19041.0",
	"10.0.20348.0",
	"10.0.22000.0",
	"10.0.22621.0",
	"10.0.26100.0",
];

/** What a platform named without a version builds against, by .NET major version; `*` for every one. */
const DEFAULT_PLATFORM_VERSIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
	windows: { "*": "7.0" },
	android: { "8": "34.0", "9": "35.0", "10": "36.0" },
	ios: { "8": "17.2", "9": "18.0", "10": "18.7" },
};

////////////////////////////////
//  Functions & Helpers

function isBlank(character: string): boolean {
	return isWhitespace(character) || isNewline(character);
}

function compareVersions(left: string, right: string): number {
	const a = left.split(".").map(Number);
	const b = right.split(".").map(Number);
	for (let index = 0; index < Math.max(a.length, b.length); index++) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

/** `prefix` plus each known version up to `version`, the target's own included. */
function orGreater(prefix: string, known: readonly string[], version: string, spell: (version: string) => string) {
	const versions = new Set([...known.filter((item) => compareVersions(item, version) <= 0), version]);
	return [...versions].map((item) => `${prefix}${spell(item)}_OR_GREATER`);
}

function underscored(version: string): string {
	return version.replaceAll(".", "_");
}

function joined(version: string): string {
	return version.replaceAll(".", "");
}

/**
 * `windows10.0.19041.0` as WINDOWS, its version's symbol, and an `_OR_GREATER` for each supported
 * version up to it. Without a version, the platform's default. A workload's platform knows only its own.
 */
function platformSymbols(platform: string, netMajor: number): string[] {
	const match = /^([a-z]+)(\d+(?:\.\d+)*)?$/u.exec(platform);
	if (match === null) return [];
	const os = match[1] as string;
	const name = os.toUpperCase();
	const defaults = DEFAULT_PLATFORM_VERSIONS[os];
	const version = match[2] ?? defaults?.[String(netMajor)] ?? defaults?.["*"];
	if (version === undefined) return [name];
	const supported =
		os === "windows" ? WINDOWS_VERSIONS.filter((item) => compareVersions(item, version) <= 0) : [version];
	return [
		name,
		`${name}${underscored(version)}`,
		...supported.map((item) => `${name}${underscored(item)}_OR_GREATER`),
	];
}

/** A `$(...)` from its `$`, the text between the parentheses; undefined when it never closes. */
function readReference(cursor: SourceCursor): string | undefined {
	cursor.take("$(");
	let depth = 1;
	let inner = "";
	let guard = -1;
	while (cursor.good()) {
		if (cursor.offset <= guard) throw new Error("property reference reader failed to advance");
		guard = cursor.offset;
		const character = cursor.next();
		if (character === "(") depth++;
		else if (character === ")" && --depth === 0) return inner;
		inner += character;
	}
	return undefined;
}

/** A quoted or bare operand of a comparison; undefined when none stands at the cursor. */
function readOperand(cursor: SourceCursor): string | undefined {
	if (cursor.take("'")) {
		const inner = cursor.readWhile((character) => character !== "'");
		return cursor.take("'") ? inner : undefined;
	}
	const bare = cursor.readWhile((character) => /^[A-Za-z0-9_.$()-]$/u.test(character));
	return bare === "" ? undefined : bare;
}

function isSymbol(word: string): boolean {
	const characters = [...word];
	const [first] = characters;
	return (
		first !== undefined &&
		isIdentifierStart(first) &&
		characters.every(isIdentifierPart) &&
		word !== "true" &&
		word !== "false"
	);
}

////////////////////////////////
//  Main

/** `%XX` escapes as their characters. */
export function unescaped(value: string): string {
	return value.replace(/%([0-9A-Fa-f]{2})/gu, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/** Property references replaced; `complete` is false when a function, item or metadata reference was dropped. */
export function expand(text: string, lookup: (name: string) => string): { value: string; complete: boolean } {
	const cursor = new SourceCursor(text);
	let value = "";
	let complete = true;
	let guard = -1;
	while (cursor.good()) {
		if (cursor.offset <= guard) throw new Error("property expansion failed to advance");
		guard = cursor.offset;
		if (cursor.startsWith("$(")) {
			const name = readReference(cursor);
			if (name !== undefined && PROPERTY_NAME.test(name)) value += lookup(name);
			else complete = false;
		} else if (cursor.startsWith("@(") || cursor.startsWith("%(")) {
			cursor.next();
			readReference(cursor);
			complete = false;
		} else {
			value += cursor.next();
		}
	}
	return { value, complete };
}

/** `[!]Exists(operand)` to its end, the operand as written; undefined when the text is not that. */
function readExists(cursor: SourceCursor): { negated: boolean; written: string } | undefined {
	const negated = cursor.take("!");
	cursor.readWhile(isBlank);
	const name = cursor.readWhile((character) => /^[A-Za-z]$/u.test(character));
	cursor.readWhile(isBlank);
	if (name.toLowerCase() !== "exists" || !cursor.take("(")) return undefined;
	cursor.readWhile(isBlank);
	const written = readOperand(cursor);
	cursor.readWhile(isBlank);
	if (written === undefined || !cursor.take(")")) return undefined;
	cursor.readWhile(isBlank);
	return cursor.good() ? undefined : { negated, written };
}

/**
 * A condition that is empty, one `==` or `!=` between two operands compared as MSBuild does,
 * ignoring case, or `[!]Exists(path)` when `exists` answers it. Undefined for anything else:
 * `and`, `or`, other functions, numbers.
 */
export function evaluateCondition(
	text: string,
	lookup: (name: string) => string,
	exists?: (written: string) => boolean | undefined,
): boolean | undefined {
	const cursor = new SourceCursor(text);
	cursor.readWhile(isBlank);
	if (!cursor.good()) return true;
	const start = cursor.mark();
	const guard = exists === undefined ? undefined : readExists(cursor);
	if (guard !== undefined && exists !== undefined) {
		const found = exists(guard.written);
		return found === undefined ? undefined : found !== guard.negated;
	}
	cursor.rewind(start);
	const left = readOperand(cursor);
	cursor.readWhile(isBlank);
	const operator = cursor.take("==") ? "==" : cursor.take("!=") ? "!=" : undefined;
	cursor.readWhile(isBlank);
	const right = readOperand(cursor);
	cursor.readWhile(isBlank);
	if (left === undefined || operator === undefined || right === undefined || cursor.good()) return undefined;
	const a = expand(left, lookup);
	const b = expand(right, lookup);
	if (!a.complete || !b.complete) return undefined;
	const equal = unescaped(a.value).toLowerCase() === unescaped(b.value).toLowerCase();
	return operator === "==" ? equal : !equal;
}

/** DefineConstants as the compiler reads it: separated by `;`, `,` or white space, symbols only. */
export function defineSymbols(value: string): string[] {
	return [
		...new Set(
			unescaped(value)
				.split(/[;,\s]+/u)
				.filter(isSymbol),
		),
	];
}

/** The SDK's implicit symbols for a target framework moniker; none for one it does not name. */
export function frameworkSymbols(targetFramework: string): string[] {
	const moniker = targetFramework.trim().toLowerCase();
	const dash = moniker.indexOf("-");
	const base = dash < 0 ? moniker : moniker.slice(0, dash);
	const platform = dash < 0 ? "" : moniker.slice(dash + 1);
	const dotted = /^(net|netcoreapp|netstandard)(\d+)\.(\d+)$/u.exec(base);
	if (dotted !== null) {
		const family = dotted[1] as string;
		const version = `${dotted[2]}.${dotted[3]}`;
		if (family === "netstandard")
			return [
				"NETSTANDARD",
				`NETSTANDARD${underscored(version)}`,
				...orGreater("NETSTANDARD", STANDARD_VERSIONS, version, underscored),
			];
		if (Number(dotted[2]) >= 5)
			return [
				"NET",
				`NET${underscored(version)}`,
				"NETCOREAPP",
				...orGreater("NET", NET_VERSIONS, version, underscored),
				...CORE_VERSIONS.map((item) => `NETCOREAPP${underscored(item)}_OR_GREATER`),
				...(platform === "" ? [] : platformSymbols(platform, Number(dotted[2]))),
			];
		if (family === "netcoreapp")
			return [
				"NETCOREAPP",
				`NETCOREAPP${underscored(version)}`,
				...orGreater("NETCOREAPP", CORE_VERSIONS, version, underscored),
			];
		return [];
	}
	const framework = /^net(\d)(\d)(\d?)$/u.exec(base);
	if (framework === null) return [];
	const version = [framework[1], framework[2], framework[3]].filter((part) => part !== "").join(".");
	return ["NETFRAMEWORK", `NET${joined(version)}`, ...orGreater("NET", FRAMEWORK_VERSIONS, version, joined)];
}
