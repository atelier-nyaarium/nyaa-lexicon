// A C# file's facts: the declaration parse, then references, literals and comments.

import { comparePositions, isTooDeep, TOO_DEEP } from "@nyaa-lexicon/protocol";
import { CsharpAttributeReader } from "./attributes.js";
import { CsharpDeclarationPass } from "./declarationPass.js";
import { CsharpDeclarationParser } from "./declarations.js";
import { CsharpExpressionReader } from "./expressions.js";
import { CsharpLocalReader } from "./locals.js";
import { CsharpMemberParser } from "./members.js";
import type { CsharpFacts } from "./model.js";
import type { CsharpParseContext } from "./parseContext.js";
import { CsharpPatternReader } from "./patterns.js";
import { CsharpProjectionPass } from "./projectionPass.js";
import { CsharpRecorder } from "./recorder.js";
import { BASE_ROLES, CsharpReferencePass } from "./referencePass.js";
import { CsharpSignatureReader } from "./signatures.js";
import { CsharpStatementParser } from "./statements.js";
import { CsharpTokenStream } from "./tokenStream.js";
import type { Token } from "./tokens.js";
import { CsharpTypeReader } from "./typeReader.js";
import { CsharpTypeParser } from "./types.js";

////////////////////////////////
//  Classes

export class CsharpParser {
	private readonly context: CsharpParseContext;

	constructor(
		module: string,
		text: string,
		outline = false,
		symbols: readonly string[] = [],
		meter?: import("@nyaa-lexicon/protocol").WorkMeter,
	) {
		const context = { module, outline, meter } as unknown as CsharpParseContext;
		// Tokens precede readers that share their indexes.
		context.tokenStream = new CsharpTokenStream(module, text, outline, symbols, meter);
		context.typeReader = new CsharpTypeReader(context);
		context.recorder = new CsharpRecorder(context);
		context.attributes = new CsharpAttributeReader(context);
		context.signatures = new CsharpSignatureReader(context);
		context.members = new CsharpMemberParser(context);
		context.types = new CsharpTypeParser(context);
		context.declarations = new CsharpDeclarationParser(context);
		context.locals = new CsharpLocalReader(context);
		context.patterns = new CsharpPatternReader(context);
		context.expressions = new CsharpExpressionReader(context);
		context.statements = new CsharpStatementParser(context);
		context.declarationPass = new CsharpDeclarationPass(context);
		context.referencePass = new CsharpReferencePass(context);
		context.projectionPass = new CsharpProjectionPass(context);
		this.context = context;
	}

	parse(): CsharpFacts {
		if (this.context.module.endsWith(".cs")) {
			this.context.tokenStream.checkDelimiters();
			try {
				this.context.declarations.parseScope(0, this.context.tokenStream.tokens.length - 1, undefined);
			} catch (error) {
				if (!isTooDeep(error)) throw error;
				this.context.tokenStream.gauge.reset();
				this.context.tokenStream.report(
					TOO_DEEP,
					this.context.tokenStream.token(this.context.tokenStream.deepest),
				);
			}
		}
		const finalized = this.context.declarationPass.finalizeDeclarations();
		if (!this.context.outline) this.context.declarationPass.scanNestedAttributes(finalized.metadata);
		// An outline keeps base lists, which binding follows across files.
		const only = this.context.outline
			? (token: Token) => BASE_ROLES.has(this.context.recorder.roleAt(token.startOffset) ?? "read")
			: undefined;
		const accesses = this.context.referencePass.memberAccesses(only);
		const typeArities = new Map<string, number>();
		const references = this.context.referencePass.extractReferences(
			finalized.metadata,
			accesses.qualified,
			typeArities,
			only,
		);
		const literals = this.context.outline ? [] : this.context.projectionPass.extractLiterals(finalized.metadata);
		const comments = this.context.outline ? [] : this.context.projectionPass.extractComments();
		const diagnostics = this.context.tokenStream.diagnostics
			.map((item) => ({ ...item, path: this.context.module }))
			.sort((left, right) => {
				const a = left.range?.start ?? { line: Number.MAX_SAFE_INTEGER, character: Number.MAX_SAFE_INTEGER };
				const b = right.range?.start ?? { line: Number.MAX_SAFE_INTEGER, character: Number.MAX_SAFE_INTEGER };
				return comparePositions(a, b);
			});
		return {
			module: this.context.module,
			role: this.context.declarationPass.fileRole(finalized.declarations, finalized.metadata),
			declarations: finalized.declarations,
			references,
			imports: this.context.recorder.imports().map((directive) => {
				const scope = this.context.recorder.importScope(directive);
				return scope === undefined
					? directive
					: { ...directive, scopeId: this.context.recorder.pathFor(scope, new Map()) };
			}),
			literals,
			comments,
			blankLines: this.context.tokenStream.lexed.blankLines,
			diagnostics,
			metadata: finalized.metadata,
			namespaceNames: this.context.recorder.namespaceNamesSnapshot().sort(),
			attributeNames: this.context.recorder.attributeNamesSnapshot(),
			baseListNames: this.context.recorder.baseListNamesSnapshot(),
			receivers: accesses.receivers,
			receiverNames: accesses.receiverNames,
			typeArities,
		};
	}
}
