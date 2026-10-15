import type { Diagnostic, HeaderSpan, NestingGauge, WorkMeter } from "@nyaa-lexicon/protocol";
import type { CsharpAttributeReader } from "./attributes.js";
import type { CsharpDeclarationPass } from "./declarationPass.js";
import type { CsharpDeclarationParser } from "./declarations.js";
import type { CsharpExpressionReader } from "./expressions.js";
import type { CsharpLocalReader } from "./locals.js";
import type { CsharpMemberParser } from "./members.js";
import type { CsharpPatternReader } from "./patterns.js";
import type { CsharpProjectionPass } from "./projectionPass.js";
import type { CsharpRecorder } from "./recorder.js";
import type { CsharpReferencePass } from "./referencePass.js";
import type { CsharpSignatureReader } from "./signatures.js";
import type { CsharpStatementParser } from "./statements.js";
import type { CommentTrivia, Token } from "./tokens.js";
import type { CsharpTypeReader } from "./typeReader.js";
import type { CsharpTypeParser } from "./types.js";

export interface CsharpTokenAccess {
	readonly lexed: {
		readonly literals: readonly Token[];
		readonly comments: readonly Token[];
		readonly trivia: ReadonlyMap<Token, CommentTrivia>;
		readonly blankLines: number[];
		readonly droppedBefore: ReadonlySet<Token>;
		readonly interpolated: ReadonlyMap<number, Token>;
	};
	readonly tokens: readonly Token[];
	readonly diagnostics: readonly Diagnostic[];
	readonly gauge: Pick<NestingGauge, "reset">;
	readonly deepest: number;
	firstComma(open: number): number;
	token(index: number): Token | undefined;
	render(span: HeaderSpan): string | undefined;
	nested<T>(index: number, read: () => T): T;
	value(index: number): string | undefined;
	nextSignificant(index: number, end?: number): number;
	previousSignificant(index: number, start?: number): number;
	matching(index: number, open: string, close: string, end?: number): number;
	opener(close: number, open: string, closer: string): number;
	report(message: string, token: Token | undefined): void;
	checkDelimiters(): void;
	findTopLevelValue(start: number, end: number, value: string): number;
	findSemicolon(start: number, end: number): number;
	lastIdentifier(start: number, end: number): number;
	sourceSpan(start: Token, end: Token): string;
	closerLine(close: number): number | undefined;
	lineAfterLast(from: number, end: number): number | undefined;
}

export interface CsharpParseContext {
	module: string;
	outline: boolean;
	meter: WorkMeter | undefined;
	tokenStream: CsharpTokenAccess;
	typeReader: CsharpTypeReader;
	recorder: CsharpRecorder;
	attributes: CsharpAttributeReader;
	signatures: CsharpSignatureReader;
	members: CsharpMemberParser;
	types: CsharpTypeParser;
	declarations: CsharpDeclarationParser;
	locals: CsharpLocalReader;
	patterns: CsharpPatternReader;
	expressions: CsharpExpressionReader;
	statements: CsharpStatementParser;
	declarationPass: CsharpDeclarationPass;
	referencePass: CsharpReferencePass;
	projectionPass: CsharpProjectionPass;
}
