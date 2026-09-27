// PowerShell's syntax grammar by recursive descent, as PowerShell's own parser reads it: the
// parser drives the tokenizer's mode, and backs up to reread a stretch in another mode. The first
// problem refuses the file.

import { type CursorMark, isTooDeep, MAX_NESTING, NestingGauge, TOO_DEEP } from "@nyaa-lexicon/protocol";
import type * as A from "./ast.js";
import { deeperThan } from "./ast.js";
import { type Mode, PowerShellSyntaxError, type SyntaxProblem, Tokenizer } from "./tokenizer.js";
import {
	BLOCK_NAMES,
	binaryPrecedence,
	type ExpandableToken,
	isAssignmentOperator,
	isKeyword,
	isModeInvariant,
	isUnaryOperator,
	type LabelToken,
	type NestedExpression,
	type NumberToken,
	type ParameterToken,
	type RedirectionToken,
	rejectsAttributes,
	type StringToken,
	type Token,
	type TokenKind,
	type VariableToken,
} from "./tokens.js";

////////////////////////////////
//  Interfaces & Types

export interface Parsed {
	/** Every token read, comments and line breaks included. */
	tokens: Token[];
	script?: A.ScriptBlock;
	problem?: SyntaxProblem;
}

type ArgumentContext =
	| "commandName"
	| "commandNameAfterInvocation"
	| "fileName"
	| "commandArgument"
	| "switchCondition";

////////////////////////////////
//  Constants

const VERBATIM_ARGUMENT = "--%";

/** Tokens that end a command's arguments. */
const ARGUMENT_ENDERS: ReadonlySet<TokenKind> = new Set([
	"Pipe",
	"RCurly",
	"RParen",
	"EndOfInput",
	"NewLine",
	"Semi",
	"Redirection",
	"RedirectInStd",
	"AndAnd",
	"OrOr",
	"Ampersand",
	"MinusMinus",
	"Comma",
]);

/** Tokens a command argument starts with that read as a primary expression. */
const PRIMARY_STARTS: ReadonlySet<TokenKind> = new Set([
	"SplattedVariable",
	"Variable",
	"Number",
	"HereStringExpandable",
	"StringExpandable",
	"HereStringLiteral",
	"StringLiteral",
	"LParen",
	"DollarParen",
	"AtParen",
	"AtCurly",
	"LCurly",
]);

/** Tokens no function name may be. */
const NOT_FUNCTION_NAMES: ReadonlySet<TokenKind> = new Set([
	"Pipe",
	"LParen",
	"LCurly",
	"AtParen",
	"AtCurly",
	"RCurly",
	"RParen",
	"EndOfInput",
	"Semi",
	"Redirection",
	"RedirectInStd",
	"AndAnd",
	"OrOr",
	"Ampersand",
	"Variable",
	"SplattedVariable",
	"HereStringExpandable",
	"HereStringLiteral",
	"StringLiteral",
	"StringExpandable",
]);

////////////////////////////////
//  Functions & Helpers

function extent(first: A.Span | Token, last: A.Span | Token): A.Span {
	return { pos: first.pos, end: last.end };
}

function isExpandable(token: Token): token is ExpandableToken {
	return "expandable" in token;
}

/** Whether a parameter token abbreviates `name`. */
function isParameter(token: Token, name: string): boolean {
	const written = (token as ParameterToken).name.toLowerCase();
	return written.length > 0 && name.toLowerCase().startsWith(written);
}

////////////////////////////////
//  Classes

class Parser {
	private tokenizer: Tokenizer;
	private ungot: Token | undefined;
	private disableComma = false;
	private readonly gauge = new NestingGauge();
	/** Tokens nested scans read, in the file's order once sorted. */
	readonly nestedTokens: Token[] = [];

	constructor(tokenizer: Tokenizer) {
		this.tokenizer = tokenizer;
	}

	////////////////////////////////
	//  Tokens

	private fail(message: string, at: A.Span | Token | number): never {
		throw new PowerShellSyntaxError({ message, pos: typeof at === "number" ? at : at.pos });
	}

	private next(): Token {
		const token = this.ungot ?? this.tokenizer.next();
		this.ungot = undefined;
		return token;
	}

	private peek(): Token {
		this.ungot ??= this.tokenizer.next();
		return this.ungot;
	}

	private skip(): void {
		this.ungot = undefined;
	}

	private unget(token: Token): void {
		this.ungot = token;
	}

	private skipNewlines(): void {
		if (this.ungot === undefined || this.ungot.kind === "NewLine") {
			this.ungot = undefined;
			this.tokenizer.skipNewlines(false);
		}
	}

	private skipNewlinesAndSemicolons(): void {
		if (this.ungot === undefined || this.ungot.kind === "NewLine" || this.ungot.kind === "Semi") {
			this.ungot = undefined;
			this.tokenizer.skipNewlines(true);
		}
	}

	private setMode(mode: Mode): void {
		if (mode !== this.tokenizer.mode && this.ungot !== undefined && !isModeInvariant(this.ungot.kind)) {
			this.resync(this.ungot);
		}
		this.tokenizer.mode = mode;
	}

	private inMode<T>(mode: Mode, read: () => T): T {
		const old = this.tokenizer.mode;
		try {
			this.setMode(mode);
			return read();
		} finally {
			this.setMode(old);
		}
	}

	private withComma<T>(disabled: boolean, read: () => T): T {
		const old = this.disableComma;
		this.disableComma = disabled;
		try {
			return read();
		} finally {
			this.disableComma = old;
		}
	}

	private resync(point: Token | CursorMark): void {
		this.ungot = undefined;
		this.tokenizer.resync(point);
	}

	private restorePoint(): CursorMark {
		if (this.ungot !== undefined) {
			const token = this.ungot;
			this.resync(token);
		}
		return this.tokenizer.restorePoint();
	}

	private nested<T>(read: () => T): T {
		try {
			this.gauge.open();
		} catch (error) {
			if (isTooDeep(error)) this.fail(TOO_DEEP, this.tokenizer.offset);
			throw error;
		}
		try {
			return read();
		} finally {
			this.gauge.close();
		}
	}

	private memberAccessToken(allowLBracket: boolean): Token | undefined {
		return this.ungot === undefined ? this.tokenizer.memberAccessOperator(allowLBracket) : undefined;
	}

	private invokeMemberToken(): Token | undefined {
		return this.ungot === undefined ? this.tokenizer.invokeMemberOpenParen() : undefined;
	}

	private lBracket(): Token | undefined {
		if (this.ungot !== undefined) return this.ungot.kind === "LBracket" ? this.next() : undefined;
		return this.tokenizer.lBracket();
	}

	private expectKind(kind: TokenKind, message: string): Token {
		const token = this.next();
		if (token.kind !== kind) this.fail(message, token);
		return token;
	}

	////////////////////////////////
	//  Script blocks

	script(): A.ScriptBlock {
		return this.scriptBlock(undefined, false);
	}

	private scriptBlock(lCurly: Token | undefined, isFilter: boolean, predefined?: A.Statement): A.ScriptBlock {
		this.skipNewlines();
		const usingStatements = lCurly === undefined ? this.usingStatements() : [];
		const restore = this.restorePoint();
		const paramBlock = this.paramBlock();
		if (paramBlock === undefined) this.resync(restore);
		this.skipNewlinesAndSemicolons();
		return this.scriptBlockBody(lCurly, usingStatements, paramBlock, isFilter, predefined);
	}

	private usingStatements(): A.UsingStatement[] {
		const statements: A.UsingStatement[] = [];
		for (;;) {
			const token = this.peek();
			if (token.kind !== "Using") {
				this.resync(token);
				return statements;
			}
			this.skip();
			statements.push(this.usingStatement(token));
			this.skipNewlinesAndSemicolons();
		}
	}

	private paramBlock(): A.ParamBlock | undefined {
		this.skipNewlines();
		const candidates = this.attributeList(false);
		this.skipNewlines();
		const paramToken = this.peek();
		if (paramToken.kind !== "Param") return undefined;
		this.skip();
		this.skipNewlines();
		const lParen = this.next();
		if (lParen.kind !== "LParen") {
			// A command named `param`.
			this.unget(lParen);
			return undefined;
		}
		const parameters = this.parameterList();
		this.skipNewlines();
		const rParen = this.expectKind("RParen", "Missing ')' in function parameter list.");
		const attributes: A.Attribute[] = [];
		for (const attribute of candidates) {
			if (attribute.type !== "AttributeAst") this.fail("A type is not allowed before param.", attribute);
			attributes.push(attribute);
		}
		return { type: "ParamBlockAst", ...extent(paramToken, rParen), attributes, parameters };
	}

	private parameterList(): A.Parameter[] {
		const parameters: A.Parameter[] = [];
		let comma: Token | undefined;
		for (;;) {
			const parameter = this.parameter();
			if (parameter === undefined) {
				if (comma !== undefined) this.fail("Missing expression after ','.", comma.end);
				return parameters;
			}
			parameters.push(parameter);
			this.skipNewlines();
			comma = this.peek();
			if (comma.kind !== "Comma") return parameters;
			this.skip();
		}
	}

	private parameter(): A.Parameter | undefined {
		return this.withComma(true, () =>
			this.inMode("expression", () => {
				this.skipNewlines();
				const attributes = this.attributeList(false);
				this.skipNewlines();
				const token = this.next();
				if (token.kind !== "Variable" && token.kind !== "SplattedVariable") {
					this.unget(token);
					if (attributes.length > 0)
						this.fail("Function parameter declaration is not valid.", attributes.at(-1) as A.Span);
					return undefined;
				}
				const name = this.variableExpression(token as VariableToken);
				this.skipNewlines();
				let defaultValue: A.Expression | undefined;
				const equals = this.peek();
				if (equals.kind === "Equals") {
					this.skip();
					this.skipNewlines();
					defaultValue = this.expression();
					if (defaultValue === undefined) this.fail("Missing expression after '='.", equals.end);
				}
				const first: A.Span = attributes[0] ?? token;
				return {
					type: "ParameterAst",
					...extent(first, defaultValue ?? token),
					name,
					attributes,
					defaultValue,
				};
			}),
		);
	}

	private attributeList(inExpressionMode: boolean): A.AttributeBase[] {
		const attributes: A.AttributeBase[] = [];
		for (let attribute = this.attribute(); attribute !== undefined; attribute = this.attribute()) {
			attributes.push(attribute);
			if (!inExpressionMode || attribute.type === "AttributeAst") this.skipNewlines();
		}
		return attributes;
	}

	private attribute(): A.AttributeBase | undefined {
		const lBracket = this.lBracket();
		if (lBracket === undefined) return undefined;
		this.skipNewlines();
		const typeName = this.typeName(true);
		if (typeName === undefined) this.fail("Missing type name after '['.", lBracket.end);
		const token = this.next();
		if (token.kind === "LParen") {
			this.skipNewlines();
			const positionalArguments: A.Expression[] = [];
			const namedArguments: A.NamedAttributeArgument[] = [];
			this.inMode("expression", () => this.attributeArguments(positionalArguments, namedArguments));
			this.skipNewlines();
			this.expectKind("RParen", "Missing closing ')' in expression.");
			this.skipNewlines();
			const rBracket = this.expectKind("RBracket", "Missing ']' at the end of an attribute or type.");
			return {
				type: "AttributeAst",
				...extent(lBracket, rBracket),
				typeName,
				positionalArguments,
				namedArguments,
			};
		}
		if (token.kind !== "RBracket") this.fail("Missing ']' at the end of an attribute or type.", token.pos);
		return { type: "TypeConstraintAst", ...extent(lBracket, token), typeName };
	}

	private attributeArguments(positional: A.Expression[], named: A.NamedAttributeArgument[]): void {
		this.withComma(true, () => {
			let comma: Token | undefined;
			for (;;) {
				this.skipNewlines();
				const name = this.simpleName();
				if (name !== undefined) {
					let argument: A.Expression;
					let omitted = false;
					if (this.peek().kind === "Equals") {
						const equals = this.next();
						this.skipNewlines();
						const value = this.expression();
						if (value === undefined) this.fail("Missing expression in named argument.", equals.end);
						argument = value;
					} else {
						argument = {
							type: "ConstantExpressionAst",
							...extent(name, name),
							text: name.value,
							value: true,
						};
						omitted = true;
					}
					named.push({
						type: "NamedAttributeArgumentAst",
						...extent(name, argument),
						argumentName: name.value,
						argument,
						expressionOmitted: omitted,
					});
				} else {
					const value = this.expression();
					if (value !== undefined) positional.push(value);
					else if (comma !== undefined) this.fail("Missing expression after ','.", comma.end);
				}
				this.skipNewlines();
				comma = this.peek();
				if (comma.kind !== "Comma") return;
				this.skip();
			}
		});
	}

	////////////////////////////////
	//  Types

	private typeName(allowAssembly: boolean): A.TypeName | undefined {
		return this.inMode("typeName", () => {
			const token = this.next();
			if (token.kind !== "Identifier") {
				this.unget(token);
				return undefined;
			}
			return this.finishTypeName(token, false, allowAssembly);
		});
	}

	private finishTypeName(name: Token, unbracketedGeneric: boolean, allowAssembly = true): A.TypeName {
		const plain: A.TypeName = { pos: name.pos, end: name.end, name: name.text };
		const token = this.peek();
		if (token.kind === "LBracket") {
			this.skip();
			this.skipNewlines();
			const inside = this.next();
			if (inside.kind === "RBracket" || inside.kind === "Comma")
				return this.arrayTypeName(plain, plain, inside, unbracketedGeneric);
			if (inside.kind === "LBracket" || inside.kind === "Identifier")
				return this.genericTypeName(name, inside, unbracketedGeneric);
			this.fail(
				inside.kind === "EndOfInput" ? "Missing type name after '['." : `Unexpected token '${inside.text}'.`,
				inside,
			);
		}
		if (token.kind === "Comma" && allowAssembly && !unbracketedGeneric) {
			this.skip();
			const assembly = this.tokenizer.assemblyNameSpec();
			if (assembly.trim() === "") this.fail("Missing assembly name specification.", token.end);
			return { ...plain, end: this.tokenizer.offset, assembly };
		}
		return plain;
	}

	private singleGenericArgument(first: Token): A.TypeName {
		if (first.kind === "Identifier") return this.finishTypeName(first, true);
		const token = this.next();
		if (token.kind !== "Identifier") this.fail("Missing type name after '['.", token.end);
		const typeName = this.finishTypeName(token, false);
		this.expectKind("RBracket", "Missing ']' at the end of a type.");
		return typeName;
	}

	private genericArguments(first: Token): { arguments: A.TypeName[]; last: Token } {
		const typeArguments = [this.singleGenericArgument(first)];
		for (;;) {
			this.skipNewlines();
			const last = this.next();
			if (last.kind !== "Comma") return { arguments: typeArguments, last };
			this.skipNewlines();
			const token = this.peek();
			if (token.kind !== "Identifier" && token.kind !== "LBracket")
				this.fail("Missing type name after ','.", last.end);
			this.skip();
			typeArguments.push(this.singleGenericArgument(token));
		}
	}

	private genericTypeName(name: Token, first: Token, unbracketedGeneric: boolean): A.TypeName {
		const { arguments: typeArguments, last } = this.genericArguments(first);
		if (last.kind !== "RBracket") this.fail("Missing ']' at the end of an attribute or type.", last.pos);
		const open: A.TypeName = { pos: name.pos, end: name.end, name: name.text };
		const generic: A.TypeName = { ...open, end: last.end, arguments: typeArguments };
		const token = this.peek();
		if (token.kind === "LBracket") {
			this.skip();
			return this.arrayTypeName(generic, open, this.next(), unbracketedGeneric);
		}
		if (token.kind === "Comma" && !unbracketedGeneric) {
			this.skip();
			const assembly = this.tokenizer.assemblyNameSpec();
			if (assembly === "") this.fail("Missing assembly name specification.", token.end);
			open.assembly = assembly;
		}
		return generic;
	}

	private arrayTypeName(
		element: A.TypeName,
		qualified: A.TypeName,
		first: Token,
		unbracketedGeneric: boolean,
	): A.TypeName {
		let current = element;
		let after = first;
		for (;;) {
			if (after.kind === "Comma") {
				let dimensions = 1;
				let token = after;
				do {
					dimensions++;
					token = this.next();
				} while (token.kind === "Comma");
				if (dimensions > 32) this.fail("Array has too many dimensions.", after);
				if (token.kind !== "RBracket") this.fail("Missing ']' at the end of an attribute or type.", token.pos);
				current = { pos: current.pos, end: token.end, name: current.name, element: current };
			} else if (after.kind === "RBracket") {
				current = { pos: current.pos, end: after.end, name: current.name, element: current };
			} else {
				this.fail(
					after.kind === "EndOfInput"
						? "Missing ']' at the end of an attribute or type."
						: `Unexpected token '${after.text}'.`,
					after,
				);
			}
			const token = this.peek();
			if (!unbracketedGeneric && token.kind === "Comma") {
				this.skip();
				const assembly = this.tokenizer.assemblyNameSpec();
				if (assembly === "") this.fail("Missing assembly name specification.", token.end);
				qualified.assembly = assembly;
				return current;
			}
			if (token.kind !== "LBracket") return current;
			this.skip();
			after = this.next();
		}
	}

	////////////////////////////////
	//  Blocks

	/** A script block's closing `}` and its span; for the top level, the end of the file. */
	private closeScriptBlock(lCurly: Token | undefined): { full: A.Span; close: Token } {
		if (lCurly === undefined) {
			const close = this.next();
			if (close.kind !== "EndOfInput")
				this.fail(`Unexpected token '${close.text}' in expression or statement.`, close);
			return { full: { pos: this.tokenizer.firstOffset, end: close.end }, close };
		}
		const close = this.expectKind("RCurly", "Missing closing '}' in statement block or type definition.");
		return { full: extent(lCurly, close), close };
	}

	/**
	 * An empty body between braces spans the gap, its last character excluded, unless the braces
	 * touch column-wise, as PowerShell measures it.
	 */
	private emptyBody(lCurly: Token | undefined, close: Token): A.Span {
		if (lCurly === undefined || lCurly.endColumn === close.column) return { pos: 0, end: 0 };
		return { pos: lCurly.end, end: Math.max(close.pos - 1, 0) };
	}

	private scriptBlockBody(
		lCurly: Token | undefined,
		usingStatements: A.UsingStatement[],
		paramBlock: A.ParamBlock | undefined,
		isFilter: boolean,
		predefined: A.Statement | undefined,
	): A.ScriptBlock {
		if (BLOCK_NAMES.has(this.peek().kind)) return this.namedBlockList(lCurly, usingStatements, paramBlock);
		const statements: A.Statement[] = predefined === undefined ? [] : [predefined];
		const traps: A.TrapStatement[] = [];
		const listed = this.statementList(statements, traps);
		let body: A.Span | undefined = paramBlock;
		if (listed !== undefined) body = body === undefined ? listed : extent(body, listed);
		const { full, close } = this.closeScriptBlock(lCurly);
		body ??= this.emptyBody(lCurly, close);
		const block: A.NamedBlock = {
			type: "NamedBlockAst",
			pos: body.pos,
			end: body.end,
			blockKind: isFilter ? "Process" : "End",
			unnamed: true,
			statements,
			traps,
		};
		return { type: "ScriptBlockAst", ...full, usingStatements, paramBlock, blocks: [block] };
	}

	private namedBlockList(
		lCurly: Token | undefined,
		usingStatements: A.UsingStatement[],
		paramBlock: A.ParamBlock | undefined,
	): A.ScriptBlock {
		const blocks: A.NamedBlock[] = [];
		const seen = new Set<TokenKind>();
		for (;;) {
			const name = this.next();
			if (name.kind === "RCurly" || name.kind === "EndOfInput") {
				this.unget(name);
				break;
			}
			if (!BLOCK_NAMES.has(name.kind))
				this.fail(`Unexpected token '${name.text}': named blocks only here.`, name);
			const body = this.statementBlock();
			if (body === undefined) this.fail(`Missing statement block after '${name.text}'.`, name.end);
			if (seen.has(name.kind)) this.fail("A script block has two blocks of the same name.", name);
			seen.add(name.kind);
			blocks.push({
				type: "NamedBlockAst",
				...extent(name, body),
				blockKind: name.kind,
				unnamed: false,
				statements: body.statements,
				traps: body.traps,
			});
			this.skipNewlinesAndSemicolons();
		}
		const { full } = this.closeScriptBlock(lCurly);
		return { type: "ScriptBlockAst", ...full, usingStatements, paramBlock, blocks };
	}

	private statementBlock(): A.StatementBlock | undefined {
		this.skipNewlines();
		const lCurly = this.next();
		if (lCurly.kind !== "LCurly") {
			this.unget(lCurly);
			return undefined;
		}
		const statements: A.Statement[] = [];
		const traps: A.TrapStatement[] = [];
		this.statementList(statements, traps);
		const rCurly = this.expectKind("RCurly", "Missing closing '}' in statement block or type definition.");
		return { type: "StatementBlockAst", ...extent(lCurly, rCurly), statements, traps };
	}

	private statementList(statements: A.Statement[], traps: A.TrapStatement[]): A.Span | undefined {
		let first: A.Statement | undefined;
		let last: A.Statement | undefined;
		this.skipNewlinesAndSemicolons();
		let guard = -1;
		for (;;) {
			const at = this.tokenizer.offset;
			if (at <= guard && this.ungot === undefined) throw new Error("powershell statement list failed to advance");
			guard = at;
			const statement = this.statement();
			if (statement === undefined) break;
			if (statement.type === "TrapStatementAst") traps.push(statement);
			else statements.push(statement);
			first ??= statement;
			last = statement;
			this.skipNewlinesAndSemicolons();
			const token = this.peek();
			if (token.kind === "RParen" || token.kind === "RCurly") break;
		}
		return first === undefined || last === undefined ? undefined : extent(first, last);
	}

	////////////////////////////////
	//  Statements

	private statement(): A.Statement | undefined {
		return this.nested(() => this.statementInner());
	}

	private statementInner(): A.Statement | undefined {
		let restore: CursorMark | undefined;
		let token = this.next();
		let attributes: A.AttributeBase[] | undefined;
		if (token.kind === "Generic" && token.text.startsWith("[")) {
			restore = this.restoreAt(token);
			attributes = this.attributeList(false);
			token = this.next();
			if (attributes.length > 0) {
				if (rejectsAttributes(token.kind)) {
					if (attributes.some((attribute) => attribute.type === "TypeConstraintAst")) {
						this.resync(restore);
						token = this.next();
					} else this.fail("Unexpected attribute.", attributes[0] as A.Span);
				} else if (isKeyword(token.kind)) {
					const type = attributes.find((attribute) => attribute.type !== "AttributeAst");
					if (type !== undefined) this.fail("A type is not allowed before a statement.", type);
				} else {
					this.resync(restore);
					token = this.next();
				}
			}
		}
		switch (token.kind) {
			case "If":
				return this.ifStatement(token);
			case "Switch":
				return this.switchStatement(undefined, token);
			case "Foreach":
				return this.foreachStatement(undefined, token);
			case "For":
				return this.forStatement(undefined, token);
			case "While":
				return this.whileStatement(undefined, token);
			case "Do":
				return this.doStatement(undefined, token);
			case "Function":
			case "Filter":
			case "Workflow":
				return this.functionDeclaration(token);
			case "Return":
			case "Throw":
			case "Exit": {
				const pipeline = this.pipelineChain();
				const kind =
					token.kind === "Return"
						? "ReturnStatementAst"
						: token.kind === "Throw"
							? "ThrowStatementAst"
							: "ExitStatementAst";
				return { type: kind, ...extent(token, pipeline ?? token), pipeline };
			}
			case "Break":
			case "Continue": {
				const label = this.labelOrKey();
				return {
					type: token.kind === "Break" ? "BreakStatementAst" : "ContinueStatementAst",
					...extent(token, label ?? token),
					label,
				};
			}
			case "Trap":
				return this.trapStatement(token);
			case "Try":
				return this.tryStatement(token);
			case "Data":
				return this.dataStatement(token);
			case "Parallel":
			case "Sequence":
				return this.blockStatement(token);
			case "Configuration":
				return this.configuration(token);
			case "From":
			case "Define":
			case "Var":
				this.fail(`The '${token.text}' keyword is not supported in this version of the language.`, token);
				break;
			case "Label":
				this.skipNewlines();
				return this.labeledStatement(token as LabelToken);
			case "EndOfInput":
				if (attributes !== undefined && restore !== undefined) {
					this.resync(restore);
					return this.pipelineChain();
				}
				this.unget(token);
				return undefined;
			case "Class":
				return this.classDefinition(attributes ?? [], token);
			case "Enum":
				return this.enumDefinition(attributes ?? [], token);
			case "Using":
				this.fail("A 'using' statement must appear before any other statements in a script.", token);
				break;
			default:
				if (attributes !== undefined && restore !== undefined) this.resync(restore);
				else this.unget(token);
				return this.pipelineChain();
		}
	}

	/** A restore point at a token already read. */
	private restoreAt(token: Token): CursorMark {
		this.resync(token);
		return this.tokenizer.restorePoint();
	}

	private labelOrKey(): A.Expression | undefined {
		const simple = this.simpleName();
		if (simple !== undefined) return simple;
		const token = this.peek();
		if (token.kind === "NewLine" || token.kind === "Semi") return undefined;
		return this.withComma(true, () => this.unaryExpression());
	}

	private simpleName(): A.StringConstantExpression | undefined {
		let token: Token;
		try {
			this.tokenizer.wantSimpleName = true;
			token = this.peek();
		} finally {
			this.tokenizer.wantSimpleName = false;
		}
		if (token.kind !== "Identifier") return undefined;
		this.skip();
		return {
			type: "StringConstantExpressionAst",
			...extent(token, token),
			value: token.text,
			stringKind: "BareWord",
		};
	}

	private labeledStatement(label: LabelToken): A.Statement | undefined {
		const token = this.next();
		switch (token.kind) {
			case "Switch":
				return this.switchStatement(label, token);
			case "Foreach":
				return this.foreachStatement(label, token);
			case "For":
				return this.forStatement(label, token);
			case "While":
				return this.whileStatement(label, token);
			case "Do":
				return this.doStatement(label, token);
			default:
				this.resync(label);
				return this.pipelineChain();
		}
	}

	private blockStatement(kindToken: Token): A.BlockStatement {
		const body = this.statementBlock();
		if (body === undefined) this.fail(`Missing statement block after '${kindToken.text}'.`, kindToken.end);
		return {
			type: "BlockStatementAst",
			...extent(kindToken, body),
			kind: kindToken.kind as "Parallel" | "Sequence",
			body,
		};
	}

	private condition(keyword: Token): { condition: A.PipelineBase; rParen: Token } {
		this.skipNewlines();
		const lParen = this.next();
		if (lParen.kind !== "LParen") this.fail(`Missing '(' after '${keyword.text}' in statement.`, lParen.pos);
		this.skipNewlines();
		const condition = this.pipelineChain();
		if (condition === undefined) this.fail(`Missing condition in '${keyword.text}' statement.`, lParen.end);
		this.skipNewlines();
		const rParen = this.expectKind(
			"RParen",
			`Missing closing ')' after expression in '${keyword.text}' statement.`,
		);
		return { condition, rParen };
	}

	private ifStatement(ifToken: Token): A.IfStatement {
		const clauses: Array<[A.PipelineBase, A.StatementBlock]> = [];
		let elseClause: A.StatementBlock | undefined;
		let keyword = ifToken;
		for (;;) {
			const { condition } = this.condition(keyword);
			this.skipNewlines();
			const body = this.statementBlock();
			if (body === undefined)
				this.fail(`Missing statement block after ${keyword.text} ( condition ).`, condition.end);
			clauses.push([condition, body]);
			const restore = this.restorePoint();
			this.skipNewlines();
			keyword = this.peek();
			if (keyword.kind === "ElseIf") {
				this.skip();
				continue;
			}
			if (keyword.kind === "Else") {
				this.skip();
				this.skipNewlines();
				elseClause = this.statementBlock();
				if (elseClause === undefined) this.fail("Missing statement block after 'else' keyword.", keyword.end);
			} else this.resync(restore);
			break;
		}
		const last: A.Span = elseClause ?? (clauses.at(-1) as [A.PipelineBase, A.StatementBlock])[1];
		return { type: "IfStatementAst", ...extent(ifToken, last), clauses, elseClause };
	}

	private switchStatement(label: LabelToken | undefined, switchToken: Token): A.SwitchStatement {
		this.skipNewlines();
		let condition: A.PipelineBase | undefined;
		let file = false;
		for (let parameter = this.peek(); parameter.kind === "Parameter"; parameter = this.peek()) {
			this.skip();
			if (
				["regex", "wildcard", "exact", "casesensitive", "parallel"].some((name) => isParameter(parameter, name))
			)
				continue;
			if (!isParameter(parameter, "file"))
				this.fail(`Invalid switch parameter '${(parameter as ParameterToken).name}'.`, parameter);
			file = true;
			this.skipNewlines();
			const fileName = this.singleCommandArgument("fileName");
			if (fileName === undefined) this.fail("Missing file name after -file.", parameter.end);
			condition = {
				type: "PipelineAst",
				...extent(fileName, fileName),
				elements: [
					{
						type: "CommandExpressionAst",
						...extent(fileName, fileName),
						expression: fileName,
						redirections: [],
					},
				],
				background: false,
			};
		}
		const lParen = this.peek();
		if (lParen.kind === "LParen") {
			if (file) this.fail("A switch with -file takes no condition in parentheses.", lParen);
			this.skip();
			this.skipNewlines();
			condition = this.pipelineChain();
			if (condition === undefined) this.fail("Missing condition in switch statement clause.", lParen.end);
			this.skipNewlines();
			this.expectKind("RParen", "Missing ')' after the switch condition.");
		} else if (condition === undefined) this.fail("Missing the switch condition.", lParen.pos);
		this.skipNewlines();
		const lCurly = this.next();
		if (lCurly.kind !== "LCurly") this.fail("Missing '{' in switch statement.", lCurly.pos);
		this.skipNewlines();
		const clauses: Array<[A.Expression, A.StatementBlock]> = [];
		let defaultClause: A.StatementBlock | undefined;
		let rCurly: Token;
		for (;;) {
			const token = this.peek();
			let clauseCondition: A.Expression;
			const isDefault = token.kind === "Default";
			if (isDefault) {
				this.skip();
				clauseCondition = {
					type: "StringConstantExpressionAst",
					...extent(token, token),
					value: token.text,
					stringKind: "BareWord",
				};
			} else {
				const parsed = this.singleCommandArgument("switchCondition");
				if (parsed === undefined) this.fail("Missing switch condition clause.", token.pos);
				clauseCondition = parsed;
			}
			const body = this.statementBlock();
			if (body === undefined)
				this.fail("Missing statement block in switch statement clause.", clauseCondition.end);
			if (isDefault) {
				if (defaultClause !== undefined) this.fail("Multiple default clauses in a switch statement.", token);
				defaultClause = body;
			} else clauses.push([clauseCondition, body]);
			this.skipNewlinesAndSemicolons();
			const after = this.peek();
			if (after.kind === "RCurly") {
				rCurly = after;
				this.skip();
				break;
			}
			if (after.kind === "EndOfInput") this.fail("Missing '}' in switch statement.", after);
		}
		return {
			type: "SwitchStatementAst",
			...extent(label ?? switchToken, rCurly),
			label: label?.label,
			condition,
			clauses,
			defaultClause,
		};
	}

	private foreachStatement(label: LabelToken | undefined, foreachToken: Token): A.ForEachStatement {
		this.skipNewlines();
		let throttleLimit: A.Expression | undefined;
		for (let parameter = this.peek(); parameter.kind === "Parameter"; parameter = this.peek()) {
			this.skip();
			if (isParameter(parameter, "throttlelimit")) {
				this.skipNewlines();
				throttleLimit = this.singleCommandArgument("commandArgument");
				if (throttleLimit === undefined) this.fail("Missing value for -ThrottleLimit.", parameter.end);
			} else if (!isParameter(parameter, "parallel"))
				this.fail(`Invalid foreach parameter '${(parameter as ParameterToken).name}'.`, parameter);
			this.skipNewlines();
		}
		const lParen = this.next();
		if (lParen.kind !== "LParen") this.fail("Missing opening '(' after keyword 'foreach'.", lParen.pos);
		this.skipNewlines();
		const token = this.next();
		if (token.kind !== "Variable" && token.kind !== "SplattedVariable")
			this.fail("Missing variable name after foreach.", token.pos);
		const variable = this.variableExpression(token as VariableToken);
		this.skipNewlines();
		const inToken = this.next();
		if (inToken.kind !== "In") this.fail("Missing 'in' after variable in foreach loop.", inToken.pos);
		this.skipNewlines();
		const condition = this.pipelineChain();
		if (condition === undefined) this.fail("Missing foreach loop collection expression.", inToken.end);
		this.skipNewlines();
		this.expectKind("RParen", "Missing closing ')' in foreach statement.");
		const body = this.statementBlock();
		if (body === undefined) this.fail("Missing statement body in foreach loop.", this.tokenizer.offset);
		return {
			type: "ForEachStatementAst",
			...extent(label ?? foreachToken, body),
			label: label?.label,
			variable,
			condition,
			body,
			throttleLimit,
		};
	}

	private forStatement(label: LabelToken | undefined, forToken: Token): A.ForStatement {
		this.skipNewlines();
		const lParen = this.next();
		if (lParen.kind !== "LParen") this.fail("Missing opening '(' after keyword 'for'.", lParen.pos);
		this.skipNewlines();
		const initializer = this.pipelineChain();
		if (this.peek().kind === "Semi") this.skip();
		this.skipNewlines();
		const condition = this.pipelineChain();
		if (this.peek().kind === "Semi") this.skip();
		this.skipNewlines();
		const iterator = this.pipelineChain();
		this.skipNewlines();
		this.expectKind("RParen", "Missing closing ')' after expression in 'for' statement.");
		const body = this.statementBlock();
		if (body === undefined) this.fail("Missing statement body in for loop.", this.tokenizer.offset);
		return {
			type: "ForStatementAst",
			...extent(label ?? forToken, body),
			label: label?.label,
			initializer,
			condition,
			iterator,
			body,
		};
	}

	private whileStatement(label: LabelToken | undefined, whileToken: Token): A.LoopStatement {
		const { condition, rParen } = this.condition(whileToken);
		this.skipNewlines();
		const body = this.statementBlock();
		if (body === undefined) this.fail("Missing statement body in while loop.", rParen.end);
		return {
			type: "WhileStatementAst",
			...extent(label ?? whileToken, body),
			label: label?.label,
			condition,
			body,
		};
	}

	private doStatement(label: LabelToken | undefined, doToken: Token): A.LoopStatement {
		const body = this.statementBlock();
		if (body === undefined) this.fail("Missing statement block after 'do'.", doToken.end);
		this.skipNewlines();
		const keyword = this.next();
		if (keyword.kind !== "While" && keyword.kind !== "Until")
			this.fail("Missing while or until in do loop.", keyword.pos);
		this.skipNewlines();
		const lParen = this.next();
		if (lParen.kind !== "LParen") this.fail(`Missing '(' after '${keyword.text}' in do loop.`, lParen.pos);
		this.skipNewlines();
		const condition = this.pipelineChain();
		if (condition === undefined) this.fail("Missing condition in do loop.", lParen.end);
		this.skipNewlines();
		const rParen = this.expectKind("RParen", "Missing closing ')' after expression in do loop.");
		return {
			type: keyword.kind === "Until" ? "DoUntilStatementAst" : "DoWhileStatementAst",
			...extent(label ?? doToken, rParen),
			label: label?.label,
			condition,
			body,
		};
	}

	private functionDeclaration(functionToken: Token): A.FunctionDefinition {
		this.skipNewlines();
		const nameToken = this.next();
		if (NOT_FUNCTION_NAMES.has(nameToken.kind))
			this.fail(`Missing name after the ${functionToken.text} keyword.`, nameToken.pos);
		const parameters = this.functionParameters() ?? [];
		const lCurly = this.next();
		if (lCurly.kind !== "LCurly") this.fail("Missing function body in function declaration.", lCurly.pos);
		const isWorkflow = functionToken.kind === "Workflow";
		const oldWorkflow = this.tokenizer.inWorkflow;
		try {
			this.tokenizer.inWorkflow = isWorkflow;
			const body = this.scriptBlock(lCurly, functionToken.kind === "Filter");
			const name = nameToken.kind === "Generic" ? (nameToken as StringToken).value : nameToken.text;
			return {
				type: "FunctionDefinitionAst",
				...extent(functionToken, body),
				isFilter: functionToken.kind === "Filter",
				isWorkflow,
				name,
				nameSpan: { pos: nameToken.pos, end: nameToken.end },
				parameters,
				body,
			};
		} finally {
			this.tokenizer.inWorkflow = oldWorkflow;
		}
	}

	private functionParameters(): A.Parameter[] | undefined {
		this.skipNewlines();
		const lParen = this.peek();
		if (lParen.kind !== "LParen") return undefined;
		this.skip();
		const parameters = this.parameterList();
		this.skipNewlines();
		this.expectKind("RParen", "Missing ')' in function parameter list.");
		this.skipNewlines();
		return parameters;
	}

	private trapStatement(trapToken: Token): A.TrapStatement {
		const restore = this.restorePoint();
		this.skipNewlines();
		const type = this.attribute();
		let trapType: A.TypeConstraint | undefined;
		if (type !== undefined && type.type !== "TypeConstraintAst") this.resync(restore);
		else trapType = type;
		const body = this.statementBlock();
		if (body === undefined) this.fail("Missing statement block in trap statement.", (trapType ?? trapToken).end);
		return { type: "TrapStatementAst", ...extent(trapToken, body), trapType, body };
	}

	private catchClause(): A.CatchClause | undefined {
		this.skipNewlines();
		const catchToken = this.next();
		if (catchToken.kind !== "Catch") {
			this.unget(catchToken);
			return undefined;
		}
		const catchTypes: A.TypeConstraint[] = [];
		let comma: Token | undefined;
		for (;;) {
			const restore = this.restorePoint();
			this.skipNewlines();
			const type = this.attribute();
			if (type === undefined) {
				if (comma !== undefined) this.fail("Missing type name after ','.", comma.end);
				break;
			}
			if (type.type !== "TypeConstraintAst") {
				this.resync(restore);
				break;
			}
			catchTypes.push(type);
			this.skipNewlines();
			comma = this.peek();
			if (comma.kind !== "Comma") break;
			this.skip();
		}
		const body = this.statementBlock();
		if (body === undefined)
			this.fail("Missing statement block in catch block.", (catchTypes.at(-1) ?? catchToken).end);
		return { type: "CatchClauseAst", ...extent(catchToken, body), catchTypes, body };
	}

	private tryStatement(tryToken: Token): A.TryStatement {
		this.skipNewlines();
		const body = this.statementBlock();
		if (body === undefined) this.fail("Missing statement block after 'try'.", tryToken.end);
		const catchClauses: A.CatchClause[] = [];
		for (let clause = this.catchClause(); clause !== undefined; clause = this.catchClause())
			catchClauses.push(clause);
		this.skipNewlines();
		let finallyClause: A.StatementBlock | undefined;
		const finallyToken = this.peek();
		if (finallyToken.kind === "Finally") {
			this.skip();
			finallyClause = this.statementBlock();
			if (finallyClause === undefined) this.fail("Missing statement block after 'finally'.", finallyToken.end);
		}
		if (catchClauses.length === 0 && finallyClause === undefined)
			this.fail("The Try statement is missing its Catch or Finally block.", body.end);
		const last: A.Span = finallyClause ?? (catchClauses.at(-1) as A.CatchClause);
		return { type: "TryStatementAst", ...extent(tryToken, last), body, catchClauses, finallyClause };
	}

	private dataStatement(dataToken: Token): A.DataStatement {
		this.skipNewlines();
		const variable = this.simpleName()?.value;
		this.skipNewlines();
		const supported = this.peek();
		const commandsAllowed: A.Expression[] = [];
		if (supported.kind === "Parameter") {
			this.skip();
			if (!isParameter(supported, "SupportedCommand"))
				this.fail(`Invalid data section parameter '${(supported as ParameterToken).name}'.`, supported);
			for (;;) {
				this.skipNewlines();
				const command = this.singleCommandArgument("commandName");
				if (command === undefined) this.fail("Missing command name.", supported.end);
				commandsAllowed.push(command);
				if (this.peek().kind !== "Comma") break;
				this.skip();
			}
		}
		const body = this.statementBlock();
		if (body === undefined) this.fail("Missing statement block in data section.", dataToken.end);
		return { type: "DataStatementAst", ...extent(dataToken, body), variable, commandsAllowed, body };
	}

	/** `configuration Name { ... }`, its body a script block whose resources read as commands. */
	private configuration(configurationToken: Token): A.ConfigurationDefinition {
		this.skipNewlines();
		const nameToken = this.next();
		const name = this.commandArgument("commandArgument", nameToken);
		if (name === undefined) this.fail("Missing configuration name.", nameToken.pos);
		this.skipNewlines();
		const lCurly = this.next();
		if (lCurly.kind !== "LCurly") this.fail("Missing '{' in configuration.", lCurly.pos);
		const body = this.scriptBlockExpression(lCurly);
		return { type: "ConfigurationDefinitionAst", ...extent(configurationToken, body), name, body };
	}

	////////////////////////////////
	//  Classes

	private classDefinition(attributes: A.AttributeBase[], classToken: Token): A.TypeDefinition {
		this.skipNewlines();
		const name = this.simpleName();
		if (name === undefined) this.fail("Missing name after the class keyword.", classToken.end);
		this.skipNewlines();
		return this.inMode("signature", () => {
			const baseTypes: A.TypeConstraint[] = [];
			if (this.peek().kind === "Colon") {
				this.skip();
				this.skipNewlines();
				for (;;) {
					const base = this.typeName(false);
					if (base === undefined) break;
					baseTypes.push({ type: "TypeConstraintAst", pos: base.pos, end: base.end, typeName: base });
					this.skipNewlines();
					if (this.peek().kind !== "Comma") break;
					this.skip();
					this.skipNewlines();
				}
			}
			const lCurly = this.next();
			if (lCurly.kind !== "LCurly") this.fail("Missing opening '{' of the class body.", lCurly.pos);
			const members: A.Member[] = [];
			for (let member = this.classMember(name.value); member !== undefined; member = this.classMember(name.value))
				members.push(member);
			const rCurly = this.expectKind("RCurly", "Missing closing '}' in statement block or type definition.");
			const typeConstraint = attributes.find((attribute) => attribute.type === "TypeConstraintAst");
			if (typeConstraint !== undefined) this.fail("A type is not allowed before a class.", typeConstraint);
			return {
				type: "TypeDefinitionAst",
				...extent(attributes[0] ?? classToken, rCurly),
				name: name.value,
				nameSpan: { pos: name.pos, end: name.end },
				bodyStart: lCurly.pos,
				isEnum: false,
				attributes: attributes as A.Attribute[],
				baseTypes,
				members,
			};
		});
	}

	private classMember(className: string): A.Member | undefined {
		let start: A.Span | undefined;
		const attributes: A.Attribute[] = [];
		let typeConstraint: A.TypeConstraint | undefined;
		let isStatic = false;
		let isHidden = false;
		let token: Token;
		for (;;) {
			this.skipNewlines();
			const attribute = this.attribute();
			if (attribute !== undefined) {
				start ??= attribute;
				if (attribute.type === "AttributeAst") attributes.push(attribute);
				else if (typeConstraint === undefined) typeConstraint = attribute;
				else this.fail("A member may have only one type.", attribute);
				continue;
			}
			token = this.peek();
			start ??= token;
			if (token.kind === "Hidden") {
				if (isHidden) this.fail("Duplicate 'hidden' modifier.", token);
				isHidden = true;
				this.skip();
				continue;
			}
			if (token.kind === "Static") {
				if (isStatic) this.fail("Duplicate 'static' modifier.", token);
				isStatic = true;
				this.skip();
				continue;
			}
			break;
		}
		if (token.kind === "Variable") {
			this.skip();
			const variable = token as VariableToken;
			let initialValue: A.Expression | undefined;
			if (this.peek().kind === "Equals") {
				this.skip();
				this.skipNewlines();
				initialValue = this.expression();
			}
			let end: A.Span = initialValue ?? token;
			const terminator = this.peek();
			if (terminator.kind !== "NewLine" && terminator.kind !== "Semi" && terminator.kind !== "RCurly") {
				this.fail("Missing a property terminator.", terminator.pos);
			}
			this.skipNewlinesAndSemicolons();
			if (terminator.kind === "Semi") end = terminator;
			return {
				type: "PropertyMemberAst",
				...extent(start, end),
				name: variable.path,
				nameSpan: { pos: token.pos + 1, end: token.end },
				propertyType: typeConstraint,
				attributes,
				isStatic,
				isHidden,
				initialValue,
			};
		}
		if (token.kind === "Identifier" || token.kind === "DynamicKeyword" || isKeyword(token.kind)) {
			this.skip();
			const method = this.methodDeclaration(token, className, isStatic);
			return {
				type: "FunctionMemberAst",
				...extent(start, method),
				body: method,
				returnType: typeConstraint,
				attributes,
				isStatic,
				isHidden,
				isConstructor: token.text.toLowerCase() === className.toLowerCase(),
			};
		}
		if (attributes.length > 0 || typeConstraint !== undefined || isStatic || isHidden)
			this.fail("Incomplete class member.", token.pos);
		return undefined;
	}

	private methodDeclaration(nameToken: Token, className: string, isStatic: boolean): A.FunctionDefinition {
		const name = nameToken.text;
		const parameters = this.peek().kind === "LParen" ? (this.functionParameters() ?? []) : [];
		const isConstructor = name.toLowerCase() === className.toLowerCase();
		let predefined: A.Statement | undefined;
		if (isConstructor && !isStatic) {
			this.skipNewlines();
			let baseArguments: A.Expression[] = [];
			let baseSpan: A.Span = { pos: 0, end: 0 };
			let keyword: A.Span = { pos: 0, end: 0 };
			this.inMode("signature", () => {
				if (this.peek().kind !== "Colon") return;
				const colon = this.next();
				this.skipNewlines();
				const baseToken = this.peek();
				if (baseToken.kind !== "Base") this.fail("Missing 'base' after ':' in a constructor.", colon.end);
				this.skip();
				this.skipNewlines();
				const lParen = this.peek();
				if (lParen.kind !== "LParen") this.fail("Missing '(' after 'base'.", baseToken.end);
				this.skip();
				const { arguments: parsed, last } = this.invokeArguments(lParen);
				baseArguments = parsed;
				baseSpan = extent(baseToken, last);
				keyword = extent(baseToken, baseToken);
				this.skipNewlines();
			});
			const call: A.BaseCtorInvokeMemberExpression = {
				type: "BaseCtorInvokeMemberExpressionAst",
				...baseSpan,
				keyword,
				arguments: baseArguments,
			};
			predefined = { type: "CommandExpressionAst", ...baseSpan, expression: call, redirections: [] };
		}
		const lCurly = this.next();
		if (lCurly.kind !== "LCurly") this.fail("Missing function body in method declaration.", lCurly.pos);
		const body = this.inMode("command", () => this.scriptBlock(lCurly, false, predefined));
		return {
			type: "FunctionDefinitionAst",
			...extent(nameToken, body),
			isFilter: false,
			isWorkflow: false,
			name,
			nameSpan: { pos: nameToken.pos, end: nameToken.end },
			parameters,
			body,
		};
	}

	private enumDefinition(attributes: A.AttributeBase[], enumToken: Token): A.TypeDefinition {
		this.skipNewlines();
		const name = this.simpleName();
		if (name === undefined) this.fail("Missing name after the enum keyword.", enumToken.end);
		return this.inMode("signature", () => {
			const baseTypes: A.TypeConstraint[] = [];
			if (this.peek().kind === "Colon") {
				const colon = this.next();
				this.skipNewlines();
				const underlying = this.typeName(false);
				if (underlying === undefined) this.fail("Missing enum underlying type.", colon.end);
				baseTypes.push({
					type: "TypeConstraintAst",
					pos: underlying.pos,
					end: underlying.end,
					typeName: underlying,
				});
			}
			this.skipNewlines();
			const lCurly = this.next();
			if (lCurly.kind !== "LCurly") this.fail("Missing opening '{' of the enum body.", lCurly.pos);
			const members: A.Member[] = [];
			for (let member = this.enumMember(); member !== undefined; member = this.enumMember()) members.push(member);
			const rCurly = this.expectKind("RCurly", "Missing closing '}' in statement block or type definition.");
			const typeConstraint = attributes.find((attribute) => attribute.type === "TypeConstraintAst");
			if (typeConstraint !== undefined) this.fail("A type is not allowed before an enum.", typeConstraint);
			return {
				type: "TypeDefinitionAst",
				...extent(attributes[0] ?? enumToken, rCurly),
				name: name.value,
				nameSpan: { pos: name.pos, end: name.end },
				bodyStart: lCurly.pos,
				isEnum: true,
				attributes: attributes as A.Attribute[],
				baseTypes,
				members,
			};
		});
	}

	private enumMember(): A.PropertyMember | undefined {
		this.skipNewlines();
		const name = this.simpleName();
		if (name === undefined) return undefined;
		let end: A.Span = name;
		let initialValue: A.Expression | undefined;
		this.inMode("expression", () => {
			const equals = this.peek();
			if (equals.kind !== "Equals") return;
			this.skip();
			initialValue = this.expression();
			if (initialValue === undefined) this.fail("Missing expression after '='.", equals.end);
			end = initialValue;
		});
		const terminator = this.peek();
		if (terminator.kind !== "NewLine" && terminator.kind !== "Semi" && terminator.kind !== "RCurly") {
			this.fail("Missing an enum member terminator.", terminator.pos);
		}
		this.skipNewlinesAndSemicolons();
		if (terminator.kind === "Semi") end = terminator;
		return {
			type: "PropertyMemberAst",
			...extent(name, end),
			name: name.value,
			nameSpan: { pos: name.pos, end: name.end },
			propertyType: undefined,
			attributes: [],
			isStatic: true,
			isHidden: false,
			initialValue,
		};
	}

	private usingStatement(usingToken: Token): A.UsingStatement {
		const directive = this.next();
		const kinds: Partial<Record<TokenKind, A.UsingStatement["usingKind"]>> = {
			Namespace: "Namespace",
			Type: "Type",
			Module: "Module",
			Command: "Command",
			Assembly: "Assembly",
		};
		const usingKind = kinds[directive.kind];
		if (usingKind === undefined)
			this.fail("Using statements support namespace, module and assembly.", directive.pos);
		const aliasAllowed = usingKind === "Namespace" || usingKind === "Module";
		const aliasRequired = usingKind === "Type" || usingKind === "Command";
		const itemToken = this.next();
		if (["EndOfInput", "NewLine", "Comma", "Semi"].includes(itemToken.kind))
			this.fail("Missing using directive argument.", itemToken.pos);
		const item = this.commandArgument("commandArgument", itemToken);
		if (item === undefined) this.fail("Missing using directive argument.", itemToken.pos);
		let moduleSpecification: A.Hashtable | undefined;
		if (item.type !== "StringConstantExpressionAst") {
			if (usingKind !== "Module" || item.type !== "HashtableAst")
				this.fail("The using argument must be a constant.", item);
			moduleSpecification = item;
		}
		const name = item.type === "StringConstantExpressionAst" ? item : undefined;
		if ((aliasAllowed || aliasRequired) && moduleSpecification === undefined) {
			const equals = this.peek();
			if (equals.kind === "Equals") {
				this.skip();
				const aliasToken = this.next();
				if (["EndOfInput", "NewLine", "Semi", "Comma"].includes(aliasToken.kind))
					this.fail("Missing using alias.", aliasToken.pos);
				const alias = this.commandArgument("commandArgument", aliasToken);
				if (usingKind === "Module" && alias?.type === "HashtableAst") {
					this.requireTerminator();
					return {
						type: "UsingStatementAst",
						...extent(usingToken, aliasToken),
						usingKind,
						name,
						alias: undefined,
						moduleSpecification: alias,
					};
				}
				if (alias?.type !== "StringConstantExpressionAst")
					this.fail("The using alias must be a constant.", alias ?? aliasToken);
				this.requireTerminator();
				return {
					type: "UsingStatementAst",
					...extent(usingToken, aliasToken),
					usingKind,
					name,
					alias,
					moduleSpecification: undefined,
				};
			}
			if (aliasRequired) this.fail("A using type or command needs an alias.", item);
		}
		this.requireTerminator();
		return {
			type: "UsingStatementAst",
			...extent(usingToken, item),
			usingKind,
			name,
			alias: undefined,
			moduleSpecification,
		};
	}

	private requireTerminator(): void {
		const token = this.peek();
		if (token.kind !== "NewLine" && token.kind !== "Semi" && token.kind !== "EndOfInput") {
			this.fail(`Unexpected token '${token.text}' in expression or statement.`, token);
		}
	}

	////////////////////////////////
	//  Pipelines

	private pipelineChain(): A.PipelineBase | undefined {
		return this.nested(() => this.pipelineChainInner());
	}

	private pipelineChainInner(): A.PipelineBase | undefined {
		let assign: Token | undefined;
		const expression = this.inMode("expression", () => {
			const parsed = this.expression();
			if (parsed !== undefined) {
				const token = this.peek();
				if (isAssignmentOperator(token.kind)) {
					this.skip();
					assign = token;
				}
			}
			return parsed;
		});
		if (expression !== undefined && assign !== undefined) {
			this.skipNewlines();
			const right = this.statement();
			if (right === undefined) this.fail(`Missing expression after '${assign.text}'.`, assign.end);
			// An expression's pipeline unwraps to the expression's command.
			const only =
				right.type === "PipelineAst" && !right.background && right.elements.length === 1
					? right.elements[0]
					: undefined;
			const value = only?.type === "CommandExpressionAst" ? only : right;
			return {
				type: "AssignmentStatementAst",
				...extent(expression, right),
				left: expression,
				operator: assign.kind,
				right: value,
			};
		}
		let start: A.Expression | undefined = expression;
		let chain: A.PipelineChain | A.Pipeline | undefined;
		let operator: Token | undefined;
		for (;;) {
			const first = start === undefined ? this.peek() : undefined;
			const pipeline = this.pipeline(start);
			start = undefined;
			if (pipeline === undefined) {
				if (operator === undefined) return undefined;
				this.fail(`Missing expression after '${operator.text}'.`, first ?? operator.end);
			}
			let next = this.peek();
			if (next.kind === "AndAnd" || next.kind === "OrOr") {
				this.skip();
				this.skipNewlines();
			} else {
				let background = false;
				if (next.kind === "Ampersand") {
					this.skip();
					next = this.peek();
					if (next.kind === "AndAnd" || next.kind === "OrOr")
						this.fail("A background operator may not precede a chain operator.", next);
					background = true;
				}
				if (chain === undefined || operator === undefined) {
					if (background) pipeline.background = true;
					return pipeline;
				}
				return {
					type: "PipelineChainAst",
					...extent(chain, pipeline),
					left: chain,
					right: pipeline,
					operator: operator.kind as "AndAnd" | "OrOr",
					background,
				};
			}
			chain =
				chain === undefined || operator === undefined
					? pipeline
					: {
							type: "PipelineChainAst",
							...extent(chain, pipeline),
							left: chain,
							right: pipeline,
							operator: operator.kind as "AndAnd" | "OrOr",
							background: false,
						};
			operator = next;
			if (this.peek().kind === "EndOfInput") this.fail(`Missing expression after '${next.text}'.`, next.end);
		}
	}

	private pipeline(startExpression?: A.Expression): A.Pipeline | undefined {
		const elements: A.CommandBase[] = [];
		let expression = startExpression;
		let pipe: Token | undefined;
		for (;;) {
			expression ??= this.inMode("expression", () => this.expression());
			let command: A.CommandBase | undefined;
			if (expression !== undefined) {
				if (elements.length > 0)
					this.fail("Expressions are only allowed as the first element of a pipeline.", expression);
				const redirections: A.Redirection[] = [];
				for (
					let token = this.peek();
					token.kind === "Redirection" || token.kind === "RedirectInStd";
					token = this.peek()
				) {
					this.skip();
					redirections.push(this.redirection(token as RedirectionToken, redirections));
				}
				command = {
					type: "CommandExpressionAst",
					...extent(expression, redirections.at(-1) ?? expression),
					expression,
					redirections,
				};
			} else command = this.command();
			if (command !== undefined) elements.push(command);
			else if (elements.length > 0 || this.peek().kind === "Pipe")
				this.fail("An empty pipe element is not allowed.", pipe?.end ?? this.peek().pos);
			expression = undefined;
			let next = this.peek();
			if (next.kind === "NewLine" && this.tokenizer.pipeFollows()) {
				this.skipNewlines();
				next = this.peek();
			}
			if (next.kind !== "Pipe") {
				if (
					!["Semi", "NewLine", "RParen", "RCurly", "EndOfInput", "AndAnd", "OrOr", "Ampersand"].includes(
						next.kind,
					)
				) {
					this.fail(`Unexpected token '${next.text}' in expression or statement.`, next);
				}
				break;
			}
			this.skip();
			pipe = next;
			this.skipNewlines();
			if (this.peek().kind === "EndOfInput") this.fail("An empty pipe element is not allowed.", next.end);
		}
		if (elements.length === 0) return undefined;
		return {
			type: "PipelineAst",
			...extent(elements[0] as A.CommandBase, elements.at(-1) as A.CommandBase),
			elements,
			background: false,
		};
	}

	private redirection(token: RedirectionToken, earlier: A.Redirection[]): A.Redirection {
		let result: A.Redirection;
		if (token.to === undefined) {
			const location = this.singleCommandArgument("fileName");
			if (location === undefined) this.fail("Missing file specification after redirection operator.", token.end);
			if (token.kind === "RedirectInStd") this.fail("The '<' operator is reserved for future use.", token);
			result = {
				type: "FileRedirectionAst",
				...extent(token, location),
				from: token.from,
				location,
				append: token.append,
			};
		} else {
			if (token.to !== "1") this.fail(`The redirection operator '${token.text}' is not supported.`, token);
			if (token.from === token.to) this.fail("A stream cannot be redirected to itself.", token);
			result = { type: "MergingRedirectionAst", ...extent(token, token), from: token.from, to: token.to };
		}
		const stream = result.from === "*" ? "*" : result.from;
		if (earlier.some((existing) => existing.from === stream))
			this.fail("The output stream is redirected more than once.", result);
		return result;
	}

	private singleCommandArgument(context: ArgumentContext): A.Expression | undefined {
		const kind = this.peek().kind;
		if (kind === "Comma" || kind === "EndOfInput") return undefined;
		return this.inMode("command", () => this.commandArgument(context, this.next()));
	}

	private commandArgument(context: ArgumentContext, first: Token): A.Expression | undefined {
		let token = first;
		const listed: A.Expression[] = [];
		let comma: Token | undefined;
		for (;;) {
			let argument: A.Expression;
			if (ARGUMENT_ENDERS.has(token.kind)) {
				this.unget(token);
				if (comma === undefined) return undefined;
				this.fail("Missing argument in parameter list.", comma.end);
			}
			if (PRIMARY_STARTS.has(token.kind)) {
				this.unget(token);
				argument = this.primaryExpression(true) as A.Expression;
			} else if (token.kind === "Generic") {
				argument =
					isExpandable(token) && context !== "commandName"
						? this.expandableString(token, "BareWord")
						: {
								type: "StringConstantExpressionAst",
								...extent(token, token),
								value: (token as StringToken).value,
								stringKind: "BareWord",
							};
			} else {
				argument = {
					type: "StringConstantExpressionAst",
					...extent(token, token),
					value: token.text,
					stringKind: "BareWord",
				};
			}
			if (context !== "commandArgument") return argument;
			if (argument.type === "StringConstantExpressionAst" && argument.value === VERBATIM_ARGUMENT) {
				if (listed.length === 0) return argument;
				listed.push(argument);
				break;
			}
			const next = this.peek();
			if (next.kind !== "Comma") {
				if (listed.length === 0) return argument;
				listed.push(argument);
				break;
			}
			comma = next;
			listed.push(argument);
			this.skip();
			this.skipNewlines();
			token = this.next();
		}
		return {
			type: "ArrayLiteralAst",
			...extent(listed[0] as A.Expression, listed.at(-1) as A.Expression),
			elements: listed,
		};
	}

	private command(): A.Command | undefined {
		let invocationOperator: "Dot" | "Ampersand" | undefined;
		const elements: A.CommandElement[] = [];
		const redirections: A.Redirection[] = [];
		const first = this.inMode("command", () => this.peek());
		let end: A.Span = first;
		this.inMode("command", () => {
			let token = this.next();
			let context: ArgumentContext = "commandName";
			if (token.kind === "Dot" || token.kind === "Ampersand") {
				invocationOperator = token.kind;
				token = this.next();
				context = "commandNameAfterInvocation";
			}
			let sawDashDash = false;
			let guard = -1;
			for (;;) {
				if (token.pos <= guard && token.kind !== "EndOfInput")
					throw new Error("powershell command parse failed to advance");
				guard = token.pos;
				if (
					[
						"Pipe",
						"RCurly",
						"RParen",
						"EndOfInput",
						"NewLine",
						"Semi",
						"AndAnd",
						"OrOr",
						"Ampersand",
					].includes(token.kind)
				) {
					this.unget(token);
					return;
				}
				let verbatim = false;
				if (token.kind === "MinusMinus") {
					end = token;
					elements.push(
						sawDashDash
							? {
									type: "StringConstantExpressionAst",
									...extent(token, token),
									value: "--",
									stringKind: "BareWord",
								}
							: {
									type: "CommandParameterAst",
									...extent(token, token),
									parameterName: "-",
									argument: undefined,
								},
					);
					sawDashDash = true;
				} else if (token.kind === "Comma") {
					this.fail("Missing argument in parameter list.", token);
				} else if (token.kind === "Parameter") {
					const parameter = token as ParameterToken;
					if (context !== "commandArgument" || sawDashDash) {
						end = token;
						elements.push({
							type: "StringConstantExpressionAst",
							...extent(token, token),
							value: token.text,
							stringKind: "BareWord",
						});
					} else {
						let argument: A.Expression | undefined;
						if (parameter.usedColon && this.peek().kind !== "Comma") {
							argument = this.commandArgument("commandArgument", this.next());
							if (argument === undefined)
								this.fail(`Missing an argument for parameter '${parameter.name}'.`, parameter.end);
						}
						end = extent(token, argument ?? token);
						elements.push({ type: "CommandParameterAst", ...end, parameterName: parameter.name, argument });
					}
				} else if (token.kind === "Redirection" || token.kind === "RedirectInStd") {
					if (context === "commandArgument") {
						const redirection = this.redirection(token as RedirectionToken, redirections);
						redirections.push(redirection);
						end = redirection;
					} else {
						end = token;
						elements.push({
							type: "StringConstantExpressionAst",
							...extent(token, token),
							value: token.text,
							stringKind: "BareWord",
						});
					}
				} else if (token.kind === "InlineScript" && context === "commandName") {
					elements.push({
						type: "StringConstantExpressionAst",
						...extent(token, token),
						value: token.text,
						stringKind: "BareWord",
					});
					this.skipNewlines();
					const lCurly = this.next();
					if (lCurly.kind !== "LCurly") this.fail("Missing statement block after 'inlinescript'.", token.end);
					const block = this.scriptBlockExpression(lCurly);
					elements.push(block);
					end = block;
				} else {
					const argument = this.commandArgument(context, token) as A.Expression;
					elements.push(argument);
					end = argument;
					if (
						token.kind === "Generic" &&
						(token as StringToken).value === VERBATIM_ARGUMENT &&
						this.ungot === undefined
					) {
						const rest = this.tokenizer.verbatimArgument();
						const verbatimArgument: A.StringConstantExpression = {
							type: "StringConstantExpressionAst",
							...extent(rest, rest),
							value: rest.value,
							stringKind: "BareWord",
						};
						elements.push(verbatimArgument);
						end = verbatimArgument;
						verbatim = true;
					}
				}
				if (verbatim) return;
				context = "commandArgument";
				token = this.next();
			}
		});
		if (elements.length === 0) {
			if (invocationOperator !== undefined)
				this.fail(`Missing expression after '${invocationOperator === "Dot" ? "." : "&"}'.`, first.end);
			return undefined;
		}
		return { type: "CommandAst", ...extent(first, end), elements, invocationOperator, redirections };
	}

	////////////////////////////////
	//  Expressions

	private expression(endNumberOnTernary = false): A.Expression | undefined {
		return this.nested(() =>
			this.inMode("expression", () => {
				const condition = this.binaryExpression(endNumberOnTernary);
				if (condition === undefined) return undefined;
				const question = this.peek();
				if (question.kind !== "QuestionMark") return condition;
				this.skip();
				this.skipNewlines();
				const ifTrue = this.expression(true);
				if (ifTrue === undefined) this.fail("Missing expression after '?'.", question.end);
				this.skipNewlines();
				const colon = this.next();
				if (colon.kind !== "Colon") this.fail("Missing ':' in the ternary expression.", colon.pos);
				this.skipNewlines();
				const ifFalse = this.expression(true);
				if (ifFalse === undefined) this.fail("Missing expression after ':'.", colon.end);
				return { type: "TernaryExpressionAst", ...extent(condition, ifFalse), condition, ifTrue, ifFalse };
			}),
		);
	}

	private binaryExpression(endNumberOnTernary: boolean): A.Expression | undefined {
		return this.inMode("expression", () => {
			let operand = this.arrayLiteral(endNumberOnTernary);
			if (operand === undefined) return undefined;
			let token = this.peek();
			if (binaryPrecedence(token.kind) === undefined) {
				if (token.kind === "Parameter")
					this.fail(`Unexpected token '${token.text}' in expression or statement.`, token);
				return operand;
			}
			this.skip();
			const operands: A.Expression[] = [operand];
			const operators: Token[] = [token];
			let precedence = binaryPrecedence(token.kind) as number;
			for (;;) {
				this.skipNewlines();
				const next = this.arrayLiteral(true);
				if (next === undefined)
					this.fail(`You must provide a value expression following the '${token.text}' operator.`, token.end);
				operands.push(next);
				token = this.next();
				const newPrecedence = binaryPrecedence(token.kind);
				if (newPrecedence === undefined) {
					this.unget(token);
					if (token.kind === "Parameter")
						this.fail(`Unexpected token '${token.text}' in expression or statement.`, token);
					break;
				}
				while (newPrecedence <= precedence) {
					const right = operands.pop() as A.Expression;
					const left = operands.pop() as A.Expression;
					const operator = operators.pop() as Token;
					operands.push({
						type: "BinaryExpressionAst",
						...extent(left, right),
						left,
						operator: operator.kind,
						right,
					});
					if (operators.length === 0) break;
					precedence = binaryPrecedence((operators.at(-1) as Token).kind) as number;
				}
				operators.push(token);
				precedence = newPrecedence;
			}
			let right = operands.pop() as A.Expression;
			while (operands.length > 0) {
				const left = operands.pop() as A.Expression;
				const operator = operators.pop() as Token;
				right = { type: "BinaryExpressionAst", ...extent(left, right), left, operator: operator.kind, right };
			}
			operand = right;
			return operand;
		});
	}

	private arrayLiteral(endNumberOnTernary: boolean): A.Expression | undefined {
		const first = this.unaryExpression(endNumberOnTernary);
		if (first === undefined) return undefined;
		let comma = this.peek();
		if (comma.kind !== "Comma" || this.disableComma) return first;
		const elements = [first];
		while (comma.kind === "Comma") {
			this.skip();
			this.skipNewlines();
			const next = this.unaryExpression(true);
			if (next === undefined) this.fail("Missing expression after ','.", comma.end);
			elements.push(next);
			comma = this.peek();
		}
		return { type: "ArrayLiteralAst", ...extent(first, elements.at(-1) as A.Expression), elements };
	}

	private unaryExpression(endNumberOnTernary = false): A.Expression | undefined {
		return this.nested(() => this.unaryInner(endNumberOnTernary));
	}

	private unaryInner(endNumberOnTernary: boolean): A.Expression | undefined {
		const oldSigned = this.tokenizer.allowSignedNumbers;
		const oldTernary = this.tokenizer.forceEndNumberOnTernary;
		let token: Token;
		try {
			this.tokenizer.allowSignedNumbers = true;
			this.tokenizer.forceEndNumberOnTernary = endNumberOnTernary;
			if (
				this.ungot !== undefined &&
				(this.ungot.kind === "Minus" || (endNumberOnTernary && this.ungot.kind === "Generic"))
			) {
				this.resync(this.ungot);
			}
			token = this.peek();
		} finally {
			this.tokenizer.allowSignedNumbers = oldSigned;
			this.tokenizer.forceEndNumberOnTernary = oldTernary;
		}
		let expression: A.Expression | undefined;
		if (isUnaryOperator(token.kind)) {
			if (this.disableComma && token.kind === "Comma") return undefined;
			this.skip();
			this.skipNewlines();
			const child = this.unaryExpression(true);
			if (child === undefined) this.fail(`Missing expression after unary operator '${token.text}'.`, token.end);
			expression =
				token.kind === "Comma"
					? { type: "ArrayLiteralAst", ...extent(token, child), elements: [child] }
					: { type: "UnaryExpressionAst", ...extent(token, child), operator: token.kind, child };
		} else if (token.kind === "LBracket") {
			const attributes = this.attributeList(true);
			if (attributes.length === 0) return undefined;
			const last = attributes.at(-1) as A.AttributeBase;
			if (last.type === "AttributeAst") {
				this.skipNewlines();
				const child = this.unaryExpression(true);
				if (child === undefined) this.fail("Missing expression after the attribute.", last.end);
				expression = { type: "AttributedExpressionAst", ...extent(last, child), attribute: last, child };
			} else {
				const member = this.ungot === undefined ? this.memberAccessToken(false) : undefined;
				if (member !== undefined) {
					expression = this.postPrimary(member, {
						type: "TypeExpressionAst",
						...extent(last, last),
						typeName: last.typeName,
					});
				} else {
					const next = this.peek();
					if (next.kind !== "NewLine" && next.kind !== "Comma") {
						const child = this.unaryExpression(true);
						if (child !== undefined)
							expression = {
								type: "ConvertExpressionAst",
								...extent(last, child),
								typeConstraint: last,
								child,
							};
					}
				}
				expression ??= { type: "TypeExpressionAst", ...extent(last, last), typeName: last.typeName };
			}
			for (let index = attributes.length - 2; index >= 0; index--) {
				const attribute = attributes[index] as A.AttributeBase;
				const child = expression as A.Expression;
				expression =
					attribute.type === "TypeConstraintAst"
						? {
								type: "ConvertExpressionAst",
								...extent(attribute, child),
								typeConstraint: attribute,
								child,
							}
						: { type: "AttributedExpressionAst", ...extent(attribute, child), attribute, child };
			}
		} else expression = this.primaryExpression(true);
		if (expression !== undefined) {
			const after = this.peek();
			if (after.kind === "PlusPlus" || after.kind === "MinusMinus") {
				this.skip();
				expression = {
					type: "UnaryExpressionAst",
					...extent(expression, after),
					operator: after.kind === "PlusPlus" ? "PostfixPlusPlus" : "PostfixMinusMinus",
					child: expression,
				};
			}
		}
		return expression;
	}

	private primaryExpression(withMemberAccess: boolean): A.Expression | undefined {
		const token = this.next();
		let expression: A.Expression;
		switch (token.kind) {
			case "SplattedVariable":
			case "Variable":
				return this.usingVariable(token as VariableToken, withMemberAccess);
			case "Number": {
				const number = token as NumberToken;
				expression = {
					type: "ConstantExpressionAst",
					...extent(token, token),
					text: number.text,
					value: number.value,
					staticType: number.staticType,
				};
				break;
			}
			case "HereStringExpandable":
			case "StringExpandable": {
				const expandable = token as ExpandableToken;
				const stringKind = token.kind === "StringExpandable" ? "DoubleQuoted" : "DoubleQuotedHereString";
				expression =
					expandable.nested.length > 0
						? this.expandableString(expandable, stringKind)
						: {
								type: "StringConstantExpressionAst",
								...extent(token, token),
								value: expandable.value,
								stringKind,
							};
				break;
			}
			case "HereStringLiteral":
			case "StringLiteral":
				expression = {
					type: "StringConstantExpressionAst",
					...extent(token, token),
					value: (token as StringToken).value,
					stringKind: token.kind === "StringLiteral" ? "SingleQuoted" : "SingleQuotedHereString",
				};
				break;
			case "LParen":
				expression = this.parenthesized(token);
				break;
			case "AtParen":
			case "DollarParen":
				expression = this.subExpression(token);
				break;
			case "AtCurly":
				expression = this.hashtable(token);
				break;
			case "LCurly":
				expression = this.scriptBlockExpression(token);
				break;
			default:
				this.unget(token);
				return undefined;
		}
		if (!withMemberAccess) return expression;
		return this.postPrimary(this.memberAccessToken(true), expression);
	}

	private variableExpression(token: VariableToken): A.VariableExpression {
		return {
			type: "VariableExpressionAst",
			...extent(token, token),
			path: token.path,
			splatted: token.kind === "SplattedVariable",
			braced: token.braced,
		};
	}

	private usingVariable(token: VariableToken, withMemberAccess: boolean): A.Expression {
		const colon = token.path.indexOf(":");
		if (colon >= 0 && token.path.slice(0, colon).toLowerCase() === "using" && colon < token.path.length - 1) {
			let child: A.Expression = { ...this.variableExpression(token), path: token.path.slice(colon + 1) };
			if (withMemberAccess) child = this.postPrimary(this.memberAccessToken(true), child);
			return { type: "UsingExpressionAst", ...extent(child, child), child };
		}
		const variable = this.variableExpression(token);
		return withMemberAccess ? this.postPrimary(this.memberAccessToken(true), variable) : variable;
	}

	private postPrimary(first: Token | undefined, target: A.Expression): A.Expression {
		let expression = target;
		for (let token = first; token !== undefined; token = this.memberAccessToken(true)) {
			this.skipNewlines();
			if (token.kind === "Dot" || token.kind === "ColonColon" || token.kind === "QuestionDot")
				expression = this.memberAccess(expression, token);
			else expression = this.elementAccess(expression, token);
		}
		return expression;
	}

	private hashtable(atCurly: Token): A.Hashtable {
		this.skipNewlines();
		const pairs: Array<[A.Expression, A.Statement]> = [];
		for (;;) {
			const pair = this.keyValuePair();
			if (pair === undefined) break;
			pairs.push(pair);
			const token = this.peek();
			if (token.kind !== "NewLine" && token.kind !== "Semi") break;
			this.skipNewlinesAndSemicolons();
		}
		const rCurly = this.expectKind("RCurly", "Missing closing '}' in hash literal.");
		return { type: "HashtableAst", ...extent(atCurly, rCurly), pairs };
	}

	private keyValuePair(): [A.Expression, A.Statement] | undefined {
		const old = this.tokenizer.mode;
		let key: A.Expression | undefined;
		let equals: Token;
		try {
			this.setMode("expression");
			key = this.labelOrKey();
			if (key === undefined) return undefined;
			equals = this.next();
		} finally {
			this.setMode(old);
		}
		if (equals.kind !== "Equals") this.fail("Missing '=' operator after key in hash literal.", key.end);
		const value = this.inMode("command", () => {
			this.skipNewlines();
			return this.statement();
		});
		if (value === undefined) this.fail("Missing statement after '=' in hash literal.", equals.end);
		return [key, value];
	}

	private scriptBlockExpression(lCurly: Token): A.ScriptBlockExpression {
		const block = this.withComma(false, () =>
			this.inMode("command", () => {
				this.skipNewlines();
				return this.scriptBlock(lCurly, false);
			}),
		);
		return { type: "ScriptBlockExpressionAst", ...extent(block, block), scriptBlock: block };
	}

	private subExpression(first: Token): A.SubExpression {
		const statements: A.Statement[] = [];
		const traps: A.TrapStatement[] = [];
		const { listed, rParen } = this.withComma(false, () =>
			this.inMode("command", () => {
				this.skipNewlines();
				const span = this.statementList(statements, traps);
				this.skipNewlines();
				return { listed: span, rParen: this.expectKind("RParen", "Missing closing ')' in subexpression.") };
			}),
		);
		const block: A.StatementBlock = {
			type: "StatementBlockAst",
			...(listed ?? { pos: 0, end: 0 }),
			statements,
			traps,
		};
		return {
			type: first.kind === "DollarParen" ? "SubExpressionAst" : "ArrayExpressionAst",
			...extent(first, rParen),
			statements: block,
		};
	}

	private parenthesized(lParen: Token): A.ParenExpression {
		const { pipeline, rParen } = this.withComma(false, () =>
			this.inMode("command", () => {
				this.skipNewlines();
				const parsed = this.pipelineChain();
				if (parsed === undefined) this.fail("An expression was expected after '('.", lParen.end);
				this.skipNewlines();
				return { pipeline: parsed, rParen: this.expectKind("RParen", "Missing closing ')' in expression.") };
			}),
		);
		return { type: "ParenExpressionAst", ...extent(lParen, rParen), pipeline };
	}

	/** A string's variables and `$(...)`, each read as its own expression. */
	private expandableString(
		token: ExpandableToken,
		stringKind: A.ExpandableStringExpression["stringKind"],
	): A.ExpandableStringExpression {
		const nestedExpressions = token.nested.map((part) => {
			if (part.kind !== "SubExpression") return this.usingVariable(part, false);
			return this.nestedScan(part);
		});
		return {
			type: "ExpandableStringExpressionAst",
			...extent(token, token),
			value: token.value,
			stringKind,
			nestedExpressions,
		};
	}

	private nestedScan(part: NestedExpression): A.Expression {
		const outer = this.tokenizer;
		const outerUngot = this.ungot;
		const inner = new Tokenizer(part.text, part.origins);
		inner.mode = "expression";
		this.tokenizer = inner;
		this.ungot = undefined;
		try {
			const expression = this.primaryExpression(true);
			if (expression === undefined) this.fail("Missing expression in subexpression.", part.pos);
			for (const { token } of inner.saved) this.nestedTokens.push(token);
			return expression;
		} finally {
			this.tokenizer = outer;
			this.ungot = outerUngot;
		}
	}

	private memberName(): A.Expression | undefined {
		const simple = this.simpleName();
		if (simple !== undefined) return simple;
		const token = this.peek();
		if (isUnaryOperator(token.kind) || token.kind === "LBracket") return this.unaryExpression();
		return this.primaryExpression(false);
	}

	private memberAccess(target: A.Expression, operator: Token): A.Expression {
		const member = this.memberName();
		if (member === undefined) this.fail("Missing property name after the reference operator.", operator.end);
		if (this.ungot === undefined) {
			const restore = this.tokenizer.restorePoint();
			const generic = this.genericMethodArguments(restore);
			const lParen = this.invokeMemberToken();
			if (lParen !== undefined)
				return this.memberInvoke(target, lParen, operator, member, generic?.arguments ?? []);
			if (generic !== undefined) this.resync(restore);
		}
		return {
			type: "MemberExpressionAst",
			...extent(target, member),
			target,
			member,
			isStatic: operator.kind === "ColonColon",
			nullConditional: operator.kind === "QuestionDot",
		};
	}

	/** `.Method[type]()`'s type arguments; undefined, reread, when no `[` holds a type. */
	private genericMethodArguments(restore: CursorMark): { arguments: A.TypeName[]; rBracket: Token } | undefined {
		const lBracket = this.next();
		if (lBracket.kind !== "LBracket") {
			this.resync(restore);
			return undefined;
		}
		let result: { arguments: A.TypeName[]; rBracket: Token } | undefined;
		const old = this.tokenizer.mode;
		try {
			this.setMode("typeName");
			this.skipNewlines();
			const first = this.next();
			if (first.kind === "Identifier") {
				const { arguments: typeArguments, last } = this.genericArguments(first);
				if (last.kind !== "RBracket")
					this.fail("Missing ']' at the end of the generic method arguments.", last.pos);
				result = { arguments: typeArguments, rBracket: last };
			}
		} finally {
			this.setMode(old);
			if (result === undefined) this.resync(restore);
		}
		return result;
	}

	private memberInvoke(
		target: A.Expression,
		open: Token,
		operator: Token,
		member: A.CommandElement,
		genericArguments: A.TypeName[],
	): A.InvokeMemberExpression {
		let invokeArguments: A.Expression[];
		let last: A.Span;
		if (open.kind === "LParen") {
			const parsed = this.invokeArguments(open);
			invokeArguments = parsed.arguments;
			last = parsed.last;
		} else {
			this.skipNewlines();
			const block = this.scriptBlockExpression(open);
			invokeArguments = [block];
			last = block;
		}
		return {
			type: "InvokeMemberExpressionAst",
			...extent(target, last),
			target,
			member,
			arguments: invokeArguments,
			isStatic: operator.kind === "ColonColon",
			nullConditional: operator.kind === "QuestionDot",
			genericArguments,
		};
	}

	private invokeArguments(lParen: Token): { arguments: A.Expression[]; last: Token } {
		return this.withComma(true, () => {
			const parsed: A.Expression[] = [];
			let comma: Token | undefined;
			for (;;) {
				this.skipNewlines();
				const argument = this.expression();
				if (argument === undefined) {
					if (comma !== undefined) this.fail("Missing argument in method call.", comma.end);
					break;
				}
				parsed.push(argument);
				this.skipNewlines();
				comma = this.next();
				if (comma.kind !== "Comma") {
					this.unget(comma);
					comma = undefined;
					break;
				}
			}
			this.skipNewlines();
			const rParen = this.expectKind("RParen", "Missing ')' in method call.");
			return { arguments: parsed, last: rParen };
		});
	}

	private elementAccess(target: A.Expression, lBracket: Token): A.IndexExpression {
		this.skipNewlines();
		const index = this.withComma(false, () => this.expression());
		if (index === undefined) this.fail("Array index expression is missing or not valid.", lBracket.end);
		this.skipNewlines();
		const rBracket = this.expectKind("RBracket", "Missing ']' after array index expression.");
		return {
			type: "IndexExpressionAst",
			...extent(target, rBracket),
			target,
			index,
			nullConditional: lBracket.kind === "QuestionLBracket",
		};
	}
}

////////////////////////////////
//  Main

/** The script's tree and every token, or the first problem. */
export function parsePowerShell(text: string): Parsed {
	const tokenizer = new Tokenizer(text);
	const parser = new Parser(tokenizer);
	const tokens = (): Token[] =>
		[...tokenizer.saved.map((entry) => entry.token), ...parser.nestedTokens].sort(
			(a, b) => a.pos - b.pos || a.end - b.end,
		);
	try {
		const script = parser.script();
		// A long operator chain builds a tree deeper than the parse nested.
		if (deeperThan(script, MAX_NESTING)) return { tokens: tokens(), problem: { message: TOO_DEEP, pos: 0 } };
		return { tokens: tokens(), script };
	} catch (error) {
		const problem =
			error instanceof PowerShellSyntaxError
				? error.problem
				: isTooDeep(error)
					? { message: TOO_DEEP, pos: 0 }
					: undefined;
		if (problem === undefined) throw error;
		tokenizer.drain();
		return { tokens: tokens(), problem };
	}
}
