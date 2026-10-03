// What a walk over the syntax tree carries, and the facts it collects.

import {
	type CommentSpan,
	type Declaration,
	type Descriptor,
	type Diagnostic,
	defined,
	type FileRole,
	type HeaderSpan,
	type Import,
	type Literal,
	type Position,
	type Range,
	type Reference,
	type TextCoordinates,
} from "@nyaa-lexicon/protocol";
import type { Expression, Statement, TypeName } from "./syntax/ast.js";

////////////////////////////////
//  Interfaces & Types

export interface PowerShellDeclaration extends Declaration {
	/** A type constraint or `[OutputType()]` as written, `[int]` read as `int`. */
	declaredType?: string;
	/** The class a value holds by how it was written: its first value, a function's output. */
	inferredType?: string;
	/** What `inferredType` was drawn from. */
	inferredBasis?: string;
	/** A class's or enum's members, by lowercase name. */
	members?: Map<string, PowerShellDeclaration[]>;
	/** A function's parameters, by lowercase name and alias. */
	parameters?: Map<string, PowerShellDeclaration>;
	/** An advanced function, which takes the common parameters too. */
	advanced?: boolean;
}

/** What a reference names beyond a bare name. */
export type Target =
	/** `scope` is the qualifier written before the name: `script`, `global`, `local` or `private`. */
	| { kind: "variable"; scope?: string }
	| { kind: "command" }
	| { kind: "type" }
	/**
	 * A member of a type: named by the literal `[T]`, or the class its receiver's value holds. A
	 * call's `arity` picks among overloads.
	 */
	| { kind: "member"; typeName?: string; isStatic: boolean; arity?: number }
	/** A named argument of a call to `command`. */
	| { kind: "parameter"; command: string };

/** A reference before binding. */
export interface PowerShellReference {
	name: string;
	range: Range;
	role: Reference["role"];
	fromId?: string;
	/** The declaration in this file the name settled on. */
	target?: string;
	/** The function in this file a command or named argument reached, whatever its parameters. */
	callee?: string;
	of: Target;
	qualified: boolean;
}

/** What an `Import-Module` member filter lets in: patterns per kind, none for a kind it leaves out. */
export interface MemberFilter {
	functions: string[];
	variables: string[];
}

/** `Import-Module -Prefix`: the text each command's noun takes, unless only the run knows it. */
export type CommandPrefix = { kind: "static"; text: string } | { kind: "dynamic" };

/** A file another brings in: a dot-source, a module import, `using module` or a manifest's entry. */
export interface SourceImport {
	specifier: string;
	/** `importerScript`: a manifest's `ScriptsToProcess`, run in the importer's scope. */
	kind: "dotSource" | "module" | "importerScript";
	range: Range;
	filter?: MemberFilter;
	/** `-Scope` or `-Global` as written; absent, a script imports into the global scope and a module into its own. */
	scope?: "local" | "global";
	prefix?: CommandPrefix;
}

export interface ParsedPowerShellFile {
	module: string;
	text: string;
	role: FileRole;
	declarations: PowerShellDeclaration[];
	references: PowerShellReference[];
	imports: Import[];
	sources: SourceImport[];
	literals: Literal[];
	comments: CommentSpan[];
	blankLines: number[];
	diagnostics: Diagnostic[];
	/** Every function by lowercase name, in source order; the last is the one a call reaches. */
	functionsByName: Map<string, PowerShellDeclaration[]>;
	/** Script-scope and global variables by lowercase name. */
	variablesByName: Map<string, PowerShellDeclaration>;
	typesByName: Map<string, PowerShellDeclaration>;
	/** Exported function patterns, lowercase; absent when the module exports every function. */
	exportedFunctions?: Set<string>;
	/** Exported variable patterns, lowercase; absent when a module exports none and a manifest all. */
	exportedVariables?: Set<string>;
}

export interface Scope {
	kind: "script" | "function" | "type" | "block";
	fromId?: string;
	/** The enclosing declarations' descriptors, so a nested id nests under them. */
	descriptors: Descriptor[];
	/** Variables declared here, by lowercase name. */
	locals: Map<string, PowerShellDeclaration>;
	parent?: Scope;
	/** The class a method's `$this` is. */
	typeName?: string;
	/** The function or method whose body this is, whose output a statement here may be. */
	owner?: PowerShellDeclaration;
}

/** A reference and the scope it was read in; targets settle after the whole file is read. */
export interface Pending {
	reference: PowerShellReference;
	scope: Scope;
	/** A member's receiver, typed once every declaration is known. */
	receiver?: Expression;
}

/** A value written in a scope, read for its type once every declaration is known. */
export interface Written {
	statement: Statement;
	scope: Scope;
	at: Position;
}

export interface PendingHeader {
	declaration: PowerShellDeclaration;
	span: HeaderSpan;
}

export interface Walk {
	module: string;
	text: string;
	coordinates: TextCoordinates;
	out: ParsedPowerShellFile;
	pending: Pending[];
	headers: PendingHeader[];
	/** Name paths already minted, so a repeat carries an occurrence. */
	minted: Map<string, number>;
	/** Where each function was defined, since one defined in a function is local to it. */
	definedIn: WeakMap<PowerShellDeclaration, Scope>;
	/** Each declaration's own descriptor, occurrence included, for the ids nested under it. */
	descriptors: WeakMap<PowerShellDeclaration, Descriptor>;
	/** Script scope. */
	script: Scope;
	/** A variable's first value. */
	firstValues: WeakMap<PowerShellDeclaration, Written>;
	/** What a function outputs or a method returns. */
	outputs: WeakMap<PowerShellDeclaration, Written[]>;
	/** Inferred types settled or being settled; null while a cycle reads it, or when none is known. */
	inferring: WeakMap<PowerShellDeclaration, string | null>;
}

////////////////////////////////
//  Constants

export const LANGUAGE = "powershell";

/** Variables PowerShell defines itself: reading one names no declaration. */
export const AUTOMATIC_VARIABLES: ReadonlySet<string> = new Set(
	[
		"$",
		"?",
		"^",
		"_",
		"args",
		"consolefilename",
		"enabledexperimentalfeatures",
		"error",
		"event",
		"eventargs",
		"eventsubscriber",
		"executioncontext",
		"false",
		"foreach",
		"home",
		"host",
		"input",
		"iscoreclr",
		"islinux",
		"ismacos",
		"iswindows",
		"lastexitcode",
		"matches",
		"myinvocation",
		"nestedpromptlevel",
		"null",
		"pid",
		"profile",
		"psboundparameters",
		"pscmdlet",
		"pscommandpath",
		"psculture",
		"psdebugcontext",
		"psedition",
		"pshome",
		"psitem",
		"psscriptroot",
		"pssenderinfo",
		"psuiculture",
		"psversiontable",
		"pwd",
		"sender",
		"shellid",
		"stacktrace",
		"switch",
		"this",
		"true",
		"erroractionpreference",
		"warningpreference",
		"verbosepreference",
		"debugpreference",
		"informationpreference",
		"progresspreference",
		"confirmpreference",
		"whatifpreference",
		"ofs",
	].map((name) => name.toLowerCase()),
);

////////////////////////////////
//  Functions & Helpers

type WildcardPart = { kind: "any" } | { kind: "one"; test: (character: string) => boolean };

/** A wildcard pattern's parts: `*`, `?`, `[a-z]` sets, and a backtick escaping what follows. */
function wildcardParts(pattern: string): WildcardPart[] {
	const characters = [...keyOf(pattern)];
	const parts: WildcardPart[] = [];
	for (let at = 0; at < characters.length; at++) {
		const character = characters[at] as string;
		if (character === "*") parts.push({ kind: "any" });
		else if (character === "?") parts.push({ kind: "one", test: () => true });
		else if (character === "`" && at + 1 < characters.length) {
			const escaped = characters[++at];
			parts.push({ kind: "one", test: (candidate) => candidate === escaped });
		} else if (character === "[" && characters.indexOf("]", at + 1) > at + 1) {
			const close = characters.indexOf("]", at + 1);
			const ranges: Array<readonly [string, string]> = [];
			for (let member = at + 1; member < close; member++) {
				const low = characters[member] as string;
				const ranged = characters[member + 1] === "-" && member + 2 < close;
				ranges.push([low, ranged ? (characters[member + 2] as string) : low]);
				if (ranged) member += 2;
			}
			at = close;
			parts.push({
				kind: "one",
				test: (candidate) => ranges.some(([low, high]) => candidate >= low && candidate <= high),
			});
		} else parts.push({ kind: "one", test: (candidate) => candidate === character });
	}
	return parts;
}

/** Whether a name matches a PowerShell wildcard pattern, without regard to case. */
export function wildcardMatches(pattern: string, name: string): boolean {
	const characters = [...keyOf(name)];
	let reached = new Set([0]);
	for (const part of wildcardParts(pattern)) {
		const next = new Set<number>();
		for (const at of reached) {
			if (part.kind === "any") for (let end = at; end <= characters.length; end++) next.add(end);
			else if (at < characters.length && part.test(characters[at] as string)) next.add(at + 1);
		}
		if (next.size === 0) return false;
		reached = next;
	}
	return reached.has(characters.length);
}

/** Whether PowerShell fills a name itself here; a plain function's `$this` is its own. */
export function isAutomatic(scope: Scope, key: string): boolean {
	if (key !== "this") return AUTOMATIC_VARIABLES.has(key);
	return scope.kind !== "function" || scope.typeName !== undefined;
}

export function rangeAt(w: Walk, start: number, end: number): Range {
	const range = w.coordinates.rangeAt(start, end);
	if (range !== undefined) return range;
	const zero = { line: 0, character: 0 };
	return { start: zero, end: zero };
}

export function pushLiteral(
	w: Walk,
	scope: Scope,
	literal: Pick<Literal, "kind" | "value" | "number">,
	start: number,
	end: number,
): void {
	w.out.literals.push({ ...literal, range: rangeAt(w, start, end), ...defined({ containerId: scope.fromId }) });
}

export function pushReference(
	w: Walk,
	scope: Scope,
	reference: Omit<PowerShellReference, "fromId">,
	receiver?: Expression,
): void {
	w.pending.push({
		reference: { ...reference, ...defined({ fromId: scope.fromId }) },
		scope,
		...defined({ receiver }),
	});
}

/** A key for a name PowerShell reads without regard to case. */
export function keyOf(name: string): string {
	return name.toLowerCase();
}

/** A string an expression spells when nothing in it runs. */
export function staticText(expression: Expression | undefined): string | undefined {
	if (expression?.type === "StringConstantExpressionAst") return expression.value;
	if (expression?.type === "ExpandableStringExpressionAst" && expression.nestedExpressions.length === 0)
		return expression.value;
	return undefined;
}

/** A type name as a class would be named: an array's element, without generic arguments. */
export function baseTypeName(type: TypeName): TypeName {
	let current = type;
	for (let element = current.element; element !== undefined; element = current.element) current = element;
	return current;
}

/** `script:x` read as the scope and the name; a drive such as `env:` answers no scope. */
export function splitScope(path: string): { scope?: string; name: string } {
	const colon = path.indexOf(":");
	if (colon < 0) return { name: path };
	return { scope: keyOf(path.slice(0, colon)), name: path.slice(colon + 1) };
}
