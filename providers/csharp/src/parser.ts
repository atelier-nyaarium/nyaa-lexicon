// A C# file's facts: the declaration parse, then references, literals and comments.

import { comparePositions, isTooDeep, TOO_DEEP } from "@nyaa-lexicon/protocol";
import type { CsharpFacts } from "./model.js";
import { CsharpProjectionPass } from "./projectionPass.js";
import { BASE_ROLES } from "./referencePass.js";
import type { Token } from "./tokens.js";

////////////////////////////////
//  Classes

export class CsharpParser extends CsharpProjectionPass {
	parse(): CsharpFacts {
		if (this.module.endsWith(".cs")) {
			this.checkDelimiters();
			try {
				this.parseScope(0, this.tokens.length - 1, undefined);
			} catch (error) {
				if (!isTooDeep(error)) throw error;
				this.gauge.reset();
				this.report(TOO_DEEP, this.token(this.deepest));
			}
		}
		const finalized = this.finalizeDeclarations();
		if (!this.outline) this.scanNestedAttributes(finalized.metadata);
		// An outline keeps base lists, which binding follows across files.
		const only = this.outline
			? (token: Token) => BASE_ROLES.has(this.roleByOffset.get(token.startOffset) ?? "read")
			: undefined;
		const accesses = this.memberAccesses(only);
		const typeArities = new Map<string, number>();
		const references = this.extractReferences(finalized.metadata, accesses.qualified, typeArities, only);
		const literals = this.outline ? [] : this.extractLiterals(finalized.metadata);
		const comments = this.outline ? [] : this.extractComments();
		const diagnostics = this.diagnostics
			.map((item) => ({ ...item, path: this.module }))
			.sort((left, right) => {
				const a = left.range?.start ?? { line: Number.MAX_SAFE_INTEGER, character: Number.MAX_SAFE_INTEGER };
				const b = right.range?.start ?? { line: Number.MAX_SAFE_INTEGER, character: Number.MAX_SAFE_INTEGER };
				return comparePositions(a, b);
			});
		return {
			module: this.module,
			role: this.fileRole(finalized.declarations, finalized.metadata),
			declarations: finalized.declarations,
			references,
			imports: this.rawImports.map((directive) => {
				const scope = this.importScopes.get(directive);
				return scope === undefined ? directive : { ...directive, scopeId: this.pathFor(scope, new Map()) };
			}),
			literals,
			comments,
			blankLines: this.lexed.blankLines,
			diagnostics,
			metadata: finalized.metadata,
			namespaceNames: [...this.namespaceNames].sort(),
			attributeNames: this.attributeNames,
			baseListNames: this.baseListNames,
			receivers: accesses.receivers,
			receiverNames: accesses.receiverNames,
			typeArities,
		};
	}
}
