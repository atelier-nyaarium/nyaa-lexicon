// The walk over the unbash tree: what each node means to an index.

import { coordinatesOf, parseSymbolId } from "@nyaa-lexicon/protocol";
import { type Command, type Node, parse, type Statement, type TestExpression } from "unbash";
import {
	aliases,
	DECLARING,
	declaring,
	letting,
	mapping,
	printing,
	reading,
	sourced,
	unsetting,
	walkAssignmentPrefix,
} from "./builtins.js";
import { commentsIn } from "./comments.js";
import {
	FUNCTION_NAME_RE,
	type ParsedBashFile,
	pushOpaque,
	pushReference,
	rangeAt,
	type Scope,
	staticValue,
	type Walk,
	wordRange,
} from "./context.js";
import { walkRedirect } from "./heredoc.js";
import { declare, settle, subshell } from "./scope.js";
import { declareOrWriteWord, walkArithmetic, walkWord, walkWords } from "./words.js";

export type { BashDeclaration, BashReference, DeclaredType, ParsedBashFile, SourceImport } from "./context.js";
export { LANGUAGE } from "./context.js";

////////////////////////////////
//  Functions & Helpers

function walkCommand(w: Walk, scope: Scope, node: Command): void {
	const name = node.name;
	if (name === undefined) {
		for (const prefix of node.prefix) walkAssignmentPrefix(w, scope, prefix, false);
	} else {
		for (const prefix of node.prefix) walkAssignmentPrefix(w, scope, prefix, true);
		const builtin = staticValue(name);
		const words = node.suffix;
		if (builtin !== undefined && DECLARING.has(builtin)) {
			declaring(w, scope, builtin, name, words);
		} else if (builtin === "read") {
			reading(w, scope, words);
		} else if (builtin === "mapfile" || builtin === "readarray") {
			mapping(w, scope, words);
		} else if (builtin === "printf") {
			printing(w, scope, words);
		} else if (builtin === "getopts") {
			walkWord(w, scope, words[0]);
			declareOrWriteWord(w, scope, words[1]);
			walkWords(w, scope, words.slice(2));
		} else if (builtin === "let") {
			letting(w, scope, words);
		} else if (builtin === "unset") {
			unsetting(w, scope, words);
		} else if (builtin === "alias") {
			aliases(w, scope, words);
		} else if (builtin === "source" || builtin === ".") {
			sourced(w, scope, words[0]);
			walkWords(w, scope, words.slice(1));
		} else {
			if (builtin !== undefined && FUNCTION_NAME_RE.test(builtin)) {
				pushReference(w, scope, { name: builtin, range: wordRange(w, name), role: "call", ofFunction: true });
			} else {
				walkWord(w, scope, name, false);
			}
			walkWords(w, scope, words);
		}
	}
	for (const redirect of node.redirects) walkRedirect(w, scope, redirect);
}

function walkTest(w: Walk, scope: Scope, expression: TestExpression): void {
	switch (expression.type) {
		case "TestUnary":
			walkWord(w, scope, expression.operand);
			break;
		case "TestBinary":
			walkWord(w, scope, expression.left);
			walkWord(w, scope, expression.right);
			break;
		case "TestLogical":
			walkTest(w, scope, expression.left);
			walkTest(w, scope, expression.right);
			break;
		case "TestNot":
			walkTest(w, scope, expression.operand);
			break;
		case "TestGroup":
			walkTest(w, scope, expression.expression);
			break;
	}
}

function walkFunction(w: Walk, scope: Scope, node: Extract<Node, { type: "Function" }>): void {
	const name = node.name.value;
	const range = rangeAt(w, node.pos, node.end);
	const declaration = declare(w, scope, name, wordRange(w, node.name), range, { kind: "function", local: false });
	declaration.metrics = { lines: range.end.line - range.start.line + 1 };
	walkWord(w, scope, node.name, false);
	const own = parseSymbolId(declaration.symbolId)?.descriptors.at(-1) ?? { kind: "method", name };
	const inner: Scope = {
		fromId: declaration.symbolId,
		descriptor: own,
		locals: new Map(),
		parent: scope,
		confined: false,
	};
	walkNode(w, inner, node.body);
	for (const redirect of node.redirects) walkRedirect(w, inner, redirect);
}

function walkStatements(w: Walk, scope: Scope, statements: Statement[]): void {
	for (const statement of statements) walkNode(w, scope, statement);
}

function walkNode(w: Walk, scope: Scope, node: Node | undefined): void {
	if (node === undefined) return;
	switch (node.type) {
		case "Statement":
			walkNode(w, scope, node.command);
			for (const redirect of node.redirects) walkRedirect(w, scope, redirect);
			break;
		case "Command":
			walkCommand(w, scope, node);
			break;
		case "Function":
			walkFunction(w, scope, node);
			break;
		case "Pipeline":
			// Each side of a pipe runs in its own subshell.
			for (const command of node.commands)
				walkNode(w, node.commands.length > 1 ? subshell(scope) : scope, command);
			break;
		case "AndOr":
			for (const command of node.commands) walkNode(w, scope, command);
			break;
		case "CompoundList":
			walkStatements(w, scope, node.commands);
			break;
		case "Subshell":
			walkNode(w, subshell(scope), node.body);
			break;
		case "BraceGroup":
			walkNode(w, scope, node.body);
			break;
		case "If":
			walkNode(w, scope, node.clause);
			walkNode(w, scope, node.then);
			walkNode(w, scope, node.else);
			break;
		case "For":
		case "Select":
			declareOrWriteWord(w, scope, node.name);
			walkWords(w, scope, node.wordlist);
			walkNode(w, scope, node.body);
			break;
		case "While":
			walkNode(w, scope, node.clause);
			walkNode(w, scope, node.body);
			break;
		case "Case":
			walkWord(w, scope, node.word);
			for (const item of node.items) {
				walkWords(w, scope, item.pattern);
				walkNode(w, scope, item.body);
			}
			break;
		case "Coproc":
			declareOrWriteWord(w, scope, node.name, "array");
			walkNode(w, subshell(scope), node.body);
			for (const redirect of node.redirects) walkRedirect(w, scope, redirect);
			break;
		case "ArithmeticFor":
			walkArithmetic(w, scope, node.initialize);
			walkArithmetic(w, scope, node.test);
			walkArithmetic(w, scope, node.update);
			pushOpaque(w, node.pos, node.body.pos);
			walkNode(w, scope, node.body);
			break;
		case "TestCommand":
			walkTest(w, scope, node.expression);
			break;
		case "ArithmeticCommand":
			walkArithmetic(w, scope, node.expression);
			pushOpaque(w, node.pos, node.end);
			break;
	}
}

////////////////////////////////
//  Main

export function parseBash(module: string, source: string): ParsedBashFile {
	const shift = source.charCodeAt(0) === 0xfeff ? 1 : 0;
	const text = source.slice(shift);
	const out: ParsedBashFile = {
		module,
		text: source,
		declarations: [],
		references: [],
		imports: [],
		sources: [],
		literals: [],
		comments: [],
		diagnostics: [],
		functionsByName: new Map(),
		globalsByName: new Map(),
	};
	const w: Walk = {
		module,
		text,
		shift,
		coordinates: coordinatesOf(source),
		out,
		pending: [],
		heredocNext: 0,
		minted: new Map(),
		definedIn: new WeakMap(),
		statements: (scope, statements) => walkStatements(w, scope, statements),
		opaque: [],
	};
	const script = parse(text);
	walkStatements(w, { locals: new Map(), confined: false }, script.commands);
	settle(w);
	out.comments = commentsIn(w);
	for (const error of script.errors ?? []) {
		out.diagnostics.push({
			severity: "error",
			message: error.message,
			range: rangeAt(w, error.pos, Math.min(error.pos + 1, text.length)),
			path: module,
		});
	}
	return out;
}
