// The Bash syntax tree: a span on every node and part, and every token kept.

////////////////////////////////
//  Interfaces & Types

/** Offsets into the parsed text: `pos` inclusive, `end` exclusive. */
export interface Span {
	pos: number;
	end: number;
}

/**
 * One lexical piece, in source order and never overlapping another. A word's quotes, expansions and
 * literal runs are pieces of their own, so a comment inside `$( )` sits between two of them.
 */
export interface Token extends Span {
	/** Where `pos` sits: zero-based line, UTF-16 column. */
	line: number;
	column: number;
	kind:
		| "code"
		| "comment"
		/** A backslash and the line break it splices. */
		| "continuation"
		/** A here-document body's text. */
		| "heredoc"
		/** The line that closes a here-document. */
		| "delimiter";
}

export interface Word extends Span {
	text: string;
	/** Quotes removed and escapes applied; expansions left as written. */
	value: string;
	/** Absent when the word holds only plain characters and escapes. */
	parts?: WordPart[];
}

export interface LiteralPart extends Span {
	type: "Literal";
	value: string;
	text: string;
}

export interface SingleQuotedPart extends Span {
	type: "SingleQuoted";
	value: string;
	text: string;
}

export interface DoubleQuotedPart extends Span {
	type: "DoubleQuoted";
	text: string;
	parts: DoubleQuotedChild[];
}

export interface AnsiCQuotedPart extends Span {
	type: "AnsiCQuoted";
	text: string;
	value: string;
}

export interface LocaleStringPart extends Span {
	type: "LocaleString";
	text: string;
	parts: DoubleQuotedChild[];
}

/** `$name`, `$1`, `$@` and the other one-character specials. */
export interface SimpleExpansionPart extends Span {
	type: "SimpleExpansion";
	text: string;
	/** Where the name starts, past the `$`. */
	name: Span;
}

export interface ParameterExpansionPart extends Span {
	type: "ParameterExpansion";
	text: string;
	parameter: string;
	/** Where `parameter` sits. */
	name: Span;
	index: string | undefined;
	indexParts?: WordPart[];
	indirect: boolean | undefined;
	length: boolean | undefined;
	operator: string | undefined;
	operand: Word | undefined;
	slice: { offset: Word; length: Word | undefined } | undefined;
	replace: { pattern: Word; replacement: Word } | undefined;
}

export interface CommandExpansionPart extends Span {
	type: "CommandExpansion";
	text: string;
	script: Script;
	/** Backquoted: its escapes were removed before the inner text was read. */
	backquoted: boolean;
}

export interface ArithmeticExpansionPart extends Span {
	type: "ArithmeticExpansion";
	text: string;
	expression: ArithmeticExpression | undefined;
}

export interface ProcessSubstitutionPart extends Span {
	type: "ProcessSubstitution";
	text: string;
	operator: "<" | ">";
	script: Script;
}

export type ExtGlobOperator = "?" | "*" | "+" | "@" | "!";

export interface ExtendedGlobPart extends Span {
	type: "ExtendedGlob";
	text: string;
	operator: ExtGlobOperator;
	pattern: string;
	parts?: WordPart[];
}

export interface BraceExpansionPart extends Span {
	type: "BraceExpansion";
	text: string;
	parts?: WordPart[];
}

export type DoubleQuotedChild =
	| LiteralPart
	| SimpleExpansionPart
	| ParameterExpansionPart
	| CommandExpansionPart
	| ArithmeticExpansionPart;

export type WordPart =
	| LiteralPart
	| SingleQuotedPart
	| DoubleQuotedPart
	| AnsiCQuotedPart
	| LocaleStringPart
	| SimpleExpansionPart
	| ParameterExpansionPart
	| CommandExpansionPart
	| ArithmeticExpansionPart
	| ProcessSubstitutionPart
	| ExtendedGlobPart
	| BraceExpansionPart;

export type ArithmeticExpression =
	| ArithmeticBinary
	| ArithmeticUnary
	| ArithmeticTernary
	| ArithmeticGroup
	| ArithmeticWord;

export interface ArithmeticBinary extends Span {
	type: "ArithmeticBinary";
	operator: string;
	left: ArithmeticExpression;
	right: ArithmeticExpression;
}

export interface ArithmeticUnary extends Span {
	type: "ArithmeticUnary";
	operator: string;
	operand: ArithmeticExpression;
	prefix: boolean;
}

export interface ArithmeticTernary extends Span {
	type: "ArithmeticTernary";
	test: ArithmeticExpression;
	consequent: ArithmeticExpression;
	alternate: ArithmeticExpression;
}

export interface ArithmeticGroup extends Span {
	type: "ArithmeticGroup";
	expression: ArithmeticExpression;
}

/** A name, a number, or a word holding expansions. */
export interface ArithmeticWord extends Span {
	type: "ArithmeticWord";
	value: string;
	parts?: WordPart[];
}

export interface AssignmentPrefix extends Span {
	type: "Assignment";
	text: string;
	name: string | undefined;
	value: Word | undefined;
	append: boolean | undefined;
	index: string | undefined;
	indexParts?: WordPart[];
	array: Word[] | undefined;
}

export type RedirectOperator = ">" | ">>" | "<" | "<<" | "<<-" | "<<<" | "<>" | "<&" | ">&" | ">|" | "&>" | "&>>";

export interface Redirect extends Span {
	operator: RedirectOperator;
	target: Word | undefined;
	fileDescriptor: number | undefined;
	variableName: string | undefined;
	/** A here-document's body text, as written. */
	content: string | undefined;
	heredocQuoted: boolean | undefined;
	/** A here-document's body; its parts expand unless the delimiter was quoted. */
	body: Word | undefined;
	/** The delimiter line; absent when the text or a substitution ends the body first. */
	closing: Span | undefined;
}

export interface Command extends Span {
	type: "Command";
	name: Word | undefined;
	prefix: AssignmentPrefix[];
	suffix: Word[];
	redirects: Redirect[];
}

export type PipeOperator = "|" | "|&";

export interface Pipeline extends Span {
	type: "Pipeline";
	commands: Node[];
	negated: boolean | undefined;
	operators: PipeOperator[];
	time: boolean | undefined;
}

export type LogicalOperator = "&&" | "||";

export interface AndOr extends Span {
	type: "AndOr";
	commands: Node[];
	operators: LogicalOperator[];
}

export interface If extends Span {
	type: "If";
	clause: CompoundList;
	then: CompoundList;
	else: CompoundList | If | undefined;
}

export interface For extends Span {
	type: "For";
	name: Word;
	wordlist: Word[];
	body: CompoundList;
}

export type WhileKind = "while" | "until";

export interface While extends Span {
	type: "While";
	kind: WhileKind;
	clause: CompoundList;
	body: CompoundList;
}

export interface Function extends Span {
	type: "Function";
	name: Word;
	body: Node;
	redirects: Redirect[];
}

export interface Subshell extends Span {
	type: "Subshell";
	body: CompoundList;
}

export interface BraceGroup extends Span {
	type: "BraceGroup";
	body: CompoundList;
}

export interface CompoundList extends Span {
	type: "CompoundList";
	commands: Statement[];
}

export interface Case extends Span {
	type: "Case";
	word: Word;
	items: CaseItem[];
}

export type CaseTerminator = ";;" | ";&" | ";;&";

export interface CaseItem extends Span {
	type: "CaseItem";
	pattern: Word[];
	body: CompoundList;
	terminator: CaseTerminator | undefined;
}

export interface Select extends Span {
	type: "Select";
	name: Word;
	wordlist: Word[];
	body: CompoundList;
}

export interface Coproc extends Span {
	type: "Coproc";
	name: Word | undefined;
	body: Node;
	redirects: Redirect[];
}

export interface ArithmeticFor extends Span {
	type: "ArithmeticFor";
	initialize: ArithmeticExpression | undefined;
	test: ArithmeticExpression | undefined;
	update: ArithmeticExpression | undefined;
	body: CompoundList;
}

export type TestExpression =
	| TestUnaryExpression
	| TestBinaryExpression
	| TestLogicalExpression
	| TestNotExpression
	| TestGroupExpression;

export interface TestUnaryExpression extends Span {
	type: "TestUnary";
	operator: string;
	operand: Word;
}

export interface TestBinaryExpression extends Span {
	type: "TestBinary";
	operator: string;
	left: Word;
	right: Word;
}

export interface TestLogicalExpression extends Span {
	type: "TestLogical";
	operator: "&&" | "||";
	left: TestExpression;
	right: TestExpression;
}

export interface TestNotExpression extends Span {
	type: "TestNot";
	operand: TestExpression;
}

export interface TestGroupExpression extends Span {
	type: "TestGroup";
	expression: TestExpression;
}

export interface TestCommand extends Span {
	type: "TestCommand";
	expression: TestExpression;
}

export interface ArithmeticCommand extends Span {
	type: "ArithmeticCommand";
	expression: ArithmeticExpression | undefined;
	body: string;
}

export interface Statement extends Span {
	type: "Statement";
	command: Node;
	background: boolean | undefined;
	redirects: Redirect[];
}

export type Node =
	| Command
	| Pipeline
	| AndOr
	| If
	| For
	| ArithmeticFor
	| Select
	| While
	| Function
	| Subshell
	| BraceGroup
	| CompoundList
	| Case
	| Coproc
	| TestCommand
	| ArithmeticCommand
	| Statement;

export interface ParseError {
	message: string;
	pos: number;
}

export interface Script extends Span {
	type: "Script";
	/** The first line, when it starts `#!`. */
	shebang?: string;
	commands: Statement[];
	errors: ParseError[];
}
