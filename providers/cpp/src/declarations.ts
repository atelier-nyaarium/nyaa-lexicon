// Declarations by recursive descent: namespaces, classes, enums, aliases and concepts, with
// functions and variables read by the layers below.

import {
	ANONYMOUS_NAMESPACE,
	type Declaration,
	type Descriptor,
	MAX_NESTING,
	qualifierDescriptors,
	type Range,
	type Reference,
	TOO_DEEP,
} from "@nyaa-lexicon/protocol";
import { bracketDelta } from "./angles.js";
import type { DeclaratorSite } from "./declarators.js";
import { SCOPE_KINDS } from "./drafts.js";
import { CppFunctionParser } from "./functions.js";
import type { TokenSpan } from "./header.js";
import type { DraftInput, DraftRecord, Prefix, Scope, TransferDraft, UsingDraft, Visibility } from "./model.js";
import { isSignificant, rangeOfToken, type Token } from "./tokens.js";
import {
	codeText,
	joinTokens,
	joinType,
	matching,
	rangeFrom,
	significantAfter,
	significantBefore,
	statementEnd,
	tokenAt,
} from "./tokenWalk.js";
import type { DeclarationStatement } from "./variables.js";
import { CLASS_KEYS, isNameToken, isShoutCase, KEYWORDS } from "./words.js";

////////////////////////////////
//  Classes

/** Declares what the reader reads; a function body's statements are the subclass's to walk. */
export abstract class CppDeclarationParser extends CppFunctionParser {
	protected readonly usings: UsingDraft[] = [];

	protected readonly transfers: TransferDraft[] = [];

	/** Scopes and blocks open around the reader. */
	protected nesting = 0;

	parse(): void {
		this.collectIncludes();
		this.parseScope(0, this.tokens.length, {
			parent: null,
			kind: "module",
			defaultVisibility: "public",
			templateDependent: false,
		});
		this.checkDelimiters();
		this.settleQualifiers();
	}

	private settleQualifiers(): void {
		const scopes = new Map<string, Descriptor>();
		for (const draft of this.drafts)
			if (SCOPE_KINDS.has(draft.kind) && !scopes.has(draft.name)) scopes.set(draft.name, draft.own);
		const declared = (name: string): Descriptor | undefined => scopes.get(name);
		for (const draft of this.drafts) {
			if (draft.qualifierNames === undefined) continue;
			draft.qualifier = qualifierDescriptors(draft.qualifierNames, declared);
		}
	}

	private parseScope(startIndex: number, limit: number, scope: Scope): void {
		if (!this.enterNesting(startIndex)) return;
		this.parseMembers(startIndex, limit, scope);
		this.nesting--;
	}

	private parseMembers(startIndex: number, limit: number, scope: Scope): number {
		let index = startIndex;
		let access = scope.defaultVisibility;
		let guard = -1;
		while (index < limit) {
			if (index <= guard) throw new Error("scope parser failed to advance");
			guard = index;
			const token = tokenAt(this.tokens, index);
			if (token === undefined) return index;
			if (!isSignificant(token)) {
				index++;
				continue;
			}
			// A brace no statement opened; its enclosing scope's range already ends past it.
			if (token.text === "}") {
				index++;
				continue;
			}
			if (token.text === "#") {
				index = this.nextLine(index);
				continue;
			}
			const accessValue = token.text;
			const accessColon = significantAfter(this.tokens, index, limit);
			if (
				(accessValue === "public" || accessValue === "protected" || accessValue === "private") &&
				tokenAt(this.tokens, accessColon)?.text === ":"
			) {
				access = accessValue;
				index = accessColon + 1;
				continue;
			}
			// A macro standing for an access label, `JSON_PRIVATE_UNLESS_TESTED:`.
			if (
				scope.kind === "class" &&
				token.kind === "identifier" &&
				isShoutCase(accessValue) &&
				tokenAt(this.tokens, accessColon)?.text === ":"
			) {
				this.excludedTokenIndexes.add(index);
				index = accessColon + 1;
				continue;
			}
			if (scope.kind !== "function") {
				const macroEnd = this.macroInvocationEnd(index, limit);
				if (macroEnd >= 0) {
					for (let excluded = index; excluded < macroEnd; excluded++) {
						if (tokenAt(this.tokens, excluded)?.kind === "identifier")
							this.excludedTokenIndexes.add(excluded);
					}
					index = macroEnd;
					continue;
				}
				const next = significantAfter(this.tokens, index, limit);
				const nextToken = tokenAt(this.tokens, next);
				if (isShoutCase(token.value) && this.isStandaloneMacroPrefix(index, next, nextToken, limit)) {
					this.excludedTokenIndexes.add(index);
					index++;
					continue;
				}
			}
			const prefix = this.readPrefix(index, limit);
			if (prefix === null) {
				index++;
				continue;
			}
			if (prefix.explicitInstantiation) {
				index = this.parseExplicitInstantiation(prefix, limit);
				continue;
			}
			const keyword = tokenAt(this.tokens, prefix.keywordIndex)?.text;
			// A linkage block, `extern "C" { ... }`, is transparent: its body belongs to this scope.
			if (keyword === "{" && prefix.modifiers.has("extern")) {
				const close = matching(this.tokens, prefix.keywordIndex, "{", "}", limit);
				if (close < 0) this.addDiagnostic("Linkage block is not closed.", prefix.keywordIndex);
				this.parseScope(prefix.keywordIndex + 1, close < 0 ? limit : close, scope);
				index = close < 0 ? limit : close + 1;
				continue;
			}
			if (keyword === "namespace") {
				index = this.parseNamespace(prefix, limit, scope);
				continue;
			}
			if (keyword === "class" || keyword === "struct" || keyword === "union" || keyword === "enum") {
				// An elaborated type, `struct stat buf;`, falls through to the declarators.
				const next =
					keyword === "enum"
						? this.parseEnum(prefix, limit, scope, access)
						: this.parseClass(prefix, limit, scope, access);
				if (next !== null) {
					index = next;
					continue;
				}
			}
			if (keyword === "using") {
				index = this.parseUsing(prefix, limit, scope, access);
				continue;
			}
			if (keyword === "typedef") {
				index = this.parseTypedef(prefix, limit, scope, access);
				continue;
			}
			if (keyword === "concept") {
				index = this.parseConcept(prefix, limit, scope, access);
				continue;
			}
			if (keyword === "static_assert") {
				index = statementEnd(this.tokens, prefix.keywordIndex, limit) + 1;
				continue;
			}
			const functionOpen = this.functionOpen(prefix, limit);
			if (functionOpen >= 0) {
				const next = this.parseFunction(prefix, functionOpen, limit, scope, access);
				if (next > index) {
					index = next;
					continue;
				}
			}
			const end = statementEnd(this.tokens, index, limit);
			this.parseVariableStatement(prefix, end + 1, scope, access);
			index = end >= index ? end + 1 : index + 1;
		}
		return index;
	}

	private parseExplicitInstantiation(prefix: Prefix, limit: number): number {
		const end = statementEnd(this.tokens, prefix.startIndex, limit);
		this.templateTokenIndexes.add(prefix.startIndex);
		this.markRoleAfter(prefix.keywordIndex, end + 1, "instantiate");
		return Math.max(prefix.startIndex + 1, end + 1);
	}

	private parseNamespace(prefix: Prefix, limit: number, scope: Scope): number {
		let index = significantAfter(this.tokens, prefix.keywordIndex, limit);
		const names: Array<{ name: string; start: number; end: number; inline: boolean }> = [];
		// `namespace a::inline b` makes only `b` inline.
		let inline = prefix.modifiers.has("inline");
		while (index >= 0 && index < limit) {
			const token = tokenAt(this.tokens, index);
			if (token?.text === "inline" && names.length > 0) {
				inline = true;
				index = significantAfter(this.tokens, index, limit);
				continue;
			}
			if (!isNameToken(token)) break;
			names.push({ name: token?.value ?? "namespace", start: index, end: index + 1, inline });
			inline = false;
			const separator = significantAfter(this.tokens, index, limit);
			if (tokenAt(this.tokens, separator)?.text !== "::") {
				index = separator;
				break;
			}
			index = significantAfter(this.tokens, separator, limit);
		}
		if (names.length === 0 && tokenAt(this.tokens, index)?.text !== "{") {
			this.addDiagnostic("Namespace declaration needs a name or body.", prefix.keywordIndex);
			return statementEnd(this.tokens, prefix.startIndex, limit) + 1;
		}
		const stop = index < 0 ? -1 : this.topLevelStop(index - 1, limit, (value) => value === "{" || value === ";");
		const open = tokenAt(this.tokens, stop)?.text === "{" ? stop : -1;
		const aliasEnd = tokenAt(this.tokens, stop)?.text === ";" ? stop : -1;
		if (open < 0) {
			if (names.length > 0) {
				const end = aliasEnd >= 0 ? aliasEnd + 1 : Math.max(prefix.startIndex + 1, index);
				// `namespace fs = std::filesystem;` names its target last.
				const target =
					aliasEnd >= 0 && tokenAt(this.tokens, index)?.text === "=" ? this.lastNameIn(index, aliasEnd) : -1;
				let parent = scope.parent;
				for (const item of names) {
					parent = this.addDraft({
						parent,
						own: { kind: "namespace", name: item.name },
						kind: "namespace",
						name: item.name,
						visibility: this.visibilityFor(scope, prefix.modifiers),
						exported: prefix.exported,
						startIndex: prefix.startIndex,
						endIndex: end,
						nameStartIndex: item.start,
						nameEndIndex: item.end,
						signature: this.header(prefix.startIndex, end, "type"),
						metrics: this.metrics.of(prefix.startIndex, end),
						templateDependent: scope.templateDependent,
						parameterNames: new Set(),
						...(target >= 0 && item === names.at(-1) ? { aliasOf: target } : {}),
					});
				}
				const [alias] = names;
				if (target >= 0 && alias !== undefined && names.length === 1)
					this.transfers.push({
						kind: "namespace",
						specifier: joinTokens(this.tokens, index + 1, target + 1),
						span: this.spanThrough(prefix.keywordIndex, aliasEnd, target),
						tokenStart: prefix.keywordIndex,
						lastName: target,
						name: this.writtenName(alias.start),
					});
			}
			return aliasEnd >= 0 ? aliasEnd + 1 : Math.max(prefix.startIndex + 1, index);
		}
		const close = matching(this.tokens, open, "{", "}", limit);
		const end = close < 0 ? limit : close + 1;
		let parent = scope.parent;
		const anonymous = { name: ANONYMOUS_NAMESPACE, start: open, end: open + 1, inline };
		for (const item of names.length === 0 ? [anonymous] : names) {
			parent = this.addDraft({
				parent,
				own: { kind: "namespace", name: item.name },
				kind: "namespace",
				name: item.name,
				visibility: this.visibilityFor(scope, prefix.modifiers),
				languageKind: item.inline ? "inline" : undefined,
				exported: prefix.exported,
				startIndex: prefix.startIndex,
				endIndex: end,
				nameStartIndex: item.start,
				nameEndIndex: item.end,
				signature: this.header(prefix.startIndex, open, "type"),
				metrics: this.metrics.of(prefix.startIndex, end),
				templateDependent: this.templateDependent(scope, prefix),
				parameterNames: new Set(),
				memberInsertLine: this.memberInsertLine(close),
			});
		}
		if (close < 0) this.addDiagnostic("Namespace body is not closed.", open);
		else {
			this.parseScope(open + 1, close, {
				parent,
				kind: "namespace",
				defaultVisibility: "public",
				templateDependent: scope.templateDependent,
			});
		}
		return end;
	}

	/**
	 * A class specifier from its key, then any declarators after its body. Null for an elaborated
	 * type, `struct stat buf;`, whose declarators the caller reads. After `typedef`, the declarators
	 * are aliases, and an unnamed class takes the first one's name.
	 */
	private parseClass(
		prefix: Prefix,
		limit: number,
		scope: Scope,
		access: Visibility,
		typedef = false,
	): number | null {
		const keywordIndex = prefix.keywordIndex;
		const keyword = tokenAt(this.tokens, keywordIndex)?.text ?? "class";
		const head = this.classHead(keywordIndex, limit);
		if (head === null || (typedef && head.body < 0)) return null;
		for (const macro of head.macros) this.excludedTokenIndexes.add(macro);
		const named = head.name >= 0;
		if (head.body < 0 && prefix.modifiers.has("friend")) {
			// `friend class X;` names a class declared elsewhere.
			this.markRoleAfter(keywordIndex, head.end, "typeUse");
			return head.end + 1;
		}
		const nameIndex = named ? head.name : keywordIndex;
		const name = named ? (tokenAt(this.tokens, nameIndex)?.value ?? "") : ANONYMOUS_NAMESPACE;
		const qualifier = named ? this.writtenQualifier(head.qualifierStart, head.name) : [];
		const qualifiedParent = this.findQualifiedParent(qualifier, scope, nameIndex);
		const parent = qualifiedParent ?? scope.parent;
		const qualifierNames = qualifiedParent === null ? qualifier : [];
		const descriptorName = this.typeDescriptorName(prefix, nameIndex, head.body >= 0 ? head.body : limit, name);
		const templateDependent = this.templateDependent(scope, prefix);
		const kind: Declaration["kind"] = keyword === "struct" ? "struct" : "class";
		const record = (start: number, end: number, headerEnd: number, extra: Partial<DraftInput>): DraftRecord =>
			this.addDraft({
				parent,
				...(qualifierNames.length === 0 ? {} : { qualifierNames }),
				own: { kind: "type", name: descriptorName },
				kind,
				name,
				visibility: this.visibilityFor(scope, prefix.modifiers, access),
				languageKind: keyword,
				exported: prefix.exported,
				startIndex: start,
				endIndex: end,
				nameStartIndex: nameIndex,
				nameEndIndex: nameIndex + 1,
				signature: this.header(typedef ? keywordIndex : start, headerEnd, "type"),
				metrics: this.metrics.of(start, end),
				templateDependent,
				parameterNames: new Set(),
				...extra,
			});
		if (head.body < 0) {
			const end = head.end + 1;
			const forward = record(prefix.startIndex, end, end, {});
			this.addTemplateParameters(prefix.template, forward, scope);
			return end;
		}
		const close = matching(this.tokens, head.body, "{", "}", limit);
		if (close < 0) this.addDiagnostic("Class body is not closed.", head.body);
		const list = close < 0 ? null : this.trailingDeclarators(close, limit);
		const end = close < 0 ? limit : list === null ? this.optionalSemicolon(close, limit) : list.end + 1;
		const alias = typedef && !named ? list?.segments[0] : undefined;
		const aliasSite = alias === undefined ? null : this.declaratorIn(alias.start, alias.end);
		const rest = list === null ? [] : aliasSite === null ? list.segments : list.segments.slice(1);
		const tagOnly = typedef && named && rest.length > 0 && rest.every((segment) => this.namesTag(segment, name));
		const target =
			alias !== undefined && aliasSite !== null
				? this.addAlias(this.classStatement(prefix, scope, access, head.body, close), aliasSite, alias, false, {
						memberInsertLine: this.memberInsertLine(close),
						bodyStart: head.body,
					})
				: record(prefix.startIndex, list === null || tagOnly ? end : close + 1, head.body, {
						memberInsertLine: this.memberInsertLine(close),
						hasBody: true,
						bodyStart: head.body,
					});
		this.addTemplateParameters(prefix.template, target, scope);
		if (head.bases >= 0) target.baseTokens = this.readClassBases(head.bases, head.body);
		if (close >= 0) {
			this.parseScope(head.body + 1, close, {
				parent: target,
				kind: "class",
				defaultVisibility: keyword === "struct" || keyword === "union" ? "public" : "private",
				templateDependent,
			});
		}
		const trailing = { body: head.body, close, declared: target };
		this.addTrailing(prefix, scope, access, trailing, rest, typedef && named ? name : undefined, typedef);
		return end;
	}

	/** `Node` in `typedef struct Node {...} Node;`: the tag's own name again, no alias of its own. */
	private namesTag(segment: TokenSpan, tag: string): boolean {
		const tokens = this.significantIndexes(segment.start, segment.end).filter(
			(index) => tokenAt(this.tokens, index)?.text !== ";",
		);
		const only = tokens.length === 1 ? tokenAt(this.tokens, tokens[0] as number) : undefined;
		return only?.kind === "identifier" && only.value === tag;
	}

	/** The declarators after a class or enum body: variables, or with `typedef` aliases, the tag's name merged. */
	private addTrailing(
		prefix: Prefix,
		scope: Scope,
		access: Visibility,
		defined: { body: number; close: number; declared: DraftRecord },
		segments: readonly TokenSpan[],
		tag: string | undefined,
		typedef: boolean,
	): void {
		if (segments.length === 0) return;
		const statement = {
			...this.classStatement(prefix, scope, access, defined.body, defined.close),
			declared: defined.declared,
		};
		for (const segment of segments) {
			if (tag !== undefined && this.namesTag(segment, tag)) {
				this.excludedTokenIndexes.add(this.significantIndexes(segment.start, segment.end)[0] as number);
				continue;
			}
			const site = this.declaratorIn(segment.start, segment.end);
			if (site === null) continue;
			if (typedef) this.addAlias(statement, site, segment, true);
			else this.addDeclarator(statement, site, segment, true);
		}
	}

	/** What the declarators after a class or enum body share: its head as their type, its whole as their lead. */
	private classStatement(
		prefix: Prefix,
		scope: Scope,
		access: Visibility,
		body: number,
		close: number,
	): DeclarationStatement {
		return {
			start: prefix.startIndex,
			specifiers: { start: prefix.keywordIndex, end: body },
			lead: { start: prefix.startIndex, end: close + 1 },
			scope: scope.kind === "class" ? { ...scope, defaultVisibility: access } : scope,
			prefix,
		};
	}

	/** An enum specifier from `enum`, then any declarators after its body; null for an elaborated type. */
	private parseEnum(prefix: Prefix, limit: number, scope: Scope, access: Visibility, typedef = false): number | null {
		const keywordIndex = prefix.keywordIndex;
		const key = significantAfter(this.tokens, keywordIndex, limit);
		const scoped = tokenAt(this.tokens, key)?.text === "class" || tokenAt(this.tokens, key)?.text === "struct";
		const head = this.enumHead(scoped ? key : keywordIndex, limit);
		if (head === null || (typedef && head.body < 0)) return null;
		const named = head.name >= 0;
		const nameIndex = named ? head.name : keywordIndex;
		const name = named ? (tokenAt(this.tokens, nameIndex)?.value ?? ANONYMOUS_NAMESPACE) : ANONYMOUS_NAMESPACE;
		const record = (start: number, end: number, headerEnd: number, extra: Partial<DraftInput>): DraftRecord =>
			this.addDraft({
				parent: scope.parent,
				own: { kind: "type", name },
				kind: "enum",
				name,
				visibility: this.visibilityFor(scope, prefix.modifiers, access),
				languageKind: scoped ? "scoped enum" : "enum",
				exported: prefix.exported,
				startIndex: start,
				endIndex: end,
				nameStartIndex: nameIndex,
				nameEndIndex: nameIndex + 1,
				signature: this.header(typedef ? keywordIndex : start, headerEnd, "type"),
				metrics: this.metrics.of(start, end),
				templateDependent: this.templateDependent(scope, prefix),
				parameterNames: new Set(),
				...extra,
			});
		if (head.body < 0) {
			const end = head.end + 1;
			const opaque = record(prefix.startIndex, end, end, { templateDependent: scope.templateDependent });
			this.addTemplateParameters(prefix.template, opaque, scope);
			return end;
		}
		const close = matching(this.tokens, head.body, "{", "}", limit);
		if (close < 0) this.addDiagnostic("Enum body is not closed.", head.body);
		const list = close < 0 ? null : this.trailingDeclarators(close, limit);
		const end = close < 0 ? limit : list === null ? this.optionalSemicolon(close, limit) : list.end + 1;
		const alias = typedef && !named ? list?.segments[0] : undefined;
		const aliasSite = alias === undefined ? null : this.declaratorIn(alias.start, alias.end);
		const rest = list === null ? [] : aliasSite === null ? list.segments : list.segments.slice(1);
		const tagOnly = typedef && named && rest.length > 0 && rest.every((segment) => this.namesTag(segment, name));
		const target =
			alias !== undefined && aliasSite !== null
				? this.addAlias(this.classStatement(prefix, scope, access, head.body, close), aliasSite, alias, false, {
						memberInsertLine: this.memberInsertLine(close),
					})
				: record(prefix.startIndex, list === null || tagOnly ? end : close + 1, head.body, {
						memberInsertLine: this.memberInsertLine(close),
					});
		this.parseEnumerators(head.body + 1, close < 0 ? limit : close, target, scope);
		const trailing = { body: head.body, close, declared: target };
		this.addTrailing(prefix, scope, access, trailing, rest, typedef && named ? name : undefined, typedef);
		return end;
	}

	private parseEnumerators(startIndex: number, limit: number, parent: DraftRecord, scope: Scope): void {
		let segmentStart = startIndex;
		let parentheses = 0;
		let brackets = 0;
		let braces = 0;
		for (let index = startIndex; index <= limit; index++) {
			const value = codeText(this.tokens, index);
			if (value === "(") parentheses++;
			else if (value === ")") parentheses = Math.max(0, parentheses - 1);
			else if (value === "[") brackets++;
			else if (value === "]") brackets = Math.max(0, brackets - 1);
			else if (value === "{") braces++;
			else if (value === "}") braces = Math.max(0, braces - 1);
			const boundary = index === limit || (value === "," && parentheses === 0 && brackets === 0 && braces === 0);
			if (!boundary) continue;
			const nameIndex = this.firstName(segmentStart, index);
			if (nameIndex >= 0) {
				const tokens = this.significantIndexes(segmentStart, index);
				const start = tokens[0] as number;
				const end = (tokens.at(-1) as number) + 1;
				this.addDraft({
					parent,
					own: { kind: "term", name: tokenAt(this.tokens, nameIndex)?.value ?? "enumerator" },
					kind: "constant",
					name: tokenAt(this.tokens, nameIndex)?.value ?? "enumerator",
					visibility: this.visibilityFor(scope, new Set(), scope.defaultVisibility),
					languageKind: "enumerator",
					exported: false,
					startIndex: start,
					endIndex: end,
					nameStartIndex: nameIndex,
					nameEndIndex: nameIndex + 1,
					signature: this.header(start, end, "value"),
					metrics: this.metrics.of(start, end),
					templateDependent: parent.templateDependent,
					parameterNames: new Set(),
				});
				this.excludedTokenIndexes.add(nameIndex);
			}
			segmentStart = index + 1;
		}
	}

	/**
	 * A `using`, `typedef`, class or enum declaration in a body, what it declares locals of the block;
	 * null for an elaborated type, `struct stat buf;`, which declares only variables.
	 */
	protected parseLocalDeclaration(first: number, limit: number, scope: Scope): number | null {
		const prefix = this.readPrefix(first, limit);
		if (prefix === null) return first + 1;
		const from = this.drafts.length;
		const keyword = tokenAt(this.tokens, prefix.keywordIndex)?.text;
		const end =
			keyword === "using"
				? this.parseUsing(prefix, limit, scope, "local")
				: keyword === "typedef"
					? this.parseTypedef(prefix, limit, scope, "local")
					: keyword === "enum"
						? this.parseEnum(prefix, limit, scope, "local")
						: this.parseClass(prefix, limit, scope, "local");
		for (const draft of this.drafts.slice(from))
			if (draft.parent === scope.parent) Object.assign(draft, this.visibleScope(scope));
		return end;
	}

	private parseUsing(prefix: Prefix, limit: number, scope: Scope, access: Visibility): number {
		const end = statementEnd(this.tokens, prefix.startIndex, limit);
		const next = significantAfter(this.tokens, prefix.keywordIndex, end);
		const using = (nameToken: number, declaration: boolean) => {
			if (nameToken < 0) return;
			const alternative = tokenAt(this.tokens, prefix.keywordIndex)?.alternative;
			// A block's using stops applying at its end; a namespace's reaches its later openings.
			const blockEnd = scope.kind === "function" ? (scope.blockEnd ?? -1) : -1;
			this.usings.push({
				scope: scope.parent,
				at: end,
				nameToken,
				declaration,
				...(blockEnd >= 0 ? { end: blockEnd } : {}),
				...(alternative === undefined ? {} : { alternative }),
			});
		};
		// A class's using-declarations bring in its bases' members, and `using enum` an enum's.
		const transfers = scope.kind !== "class" && tokenAt(this.tokens, next)?.text !== "enum";
		if (tokenAt(this.tokens, next)?.text === "namespace") {
			this.markRoleAfter(prefix.keywordIndex, end, "import");
			const namespace = this.lastNameIn(next, end);
			using(namespace, false);
			if (transfers && namespace >= 0)
				this.transfers.push({
					kind: "injection",
					specifier: joinTokens(this.tokens, next + 1, namespace + 1),
					span: this.spanThrough(prefix.keywordIndex, end, namespace),
					tokenStart: prefix.keywordIndex,
					lastName: namespace,
				});
			return end + 1;
		}
		const equals = this.findNextText(prefix.keywordIndex, "=", end);
		const nameIndex = significantAfter(this.tokens, prefix.keywordIndex, end);
		if (equals >= 0 && nameIndex >= 0 && tokenAt(this.tokens, nameIndex)?.kind === "identifier") {
			const name = tokenAt(this.tokens, nameIndex)?.value ?? "Alias";
			const typeIndexes = this.significantIndexes(equals + 1, end);
			for (const typeIndex of typeIndexes)
				if (tokenAt(this.tokens, typeIndex)?.kind === "identifier") this.typeTokenIndexes.add(typeIndex);
			const alias = this.addDraft({
				parent: scope.parent,
				own: { kind: "type", name },
				kind: "class",
				name,
				visibility: this.visibilityFor(scope, prefix.modifiers, access),
				languageKind: "using alias",
				exported: prefix.exported,
				startIndex: prefix.startIndex,
				endIndex: end + 1,
				nameStartIndex: nameIndex,
				nameEndIndex: nameIndex + 1,
				signature: this.header(prefix.startIndex, end + 1, "type"),
				metrics: this.metrics.of(prefix.startIndex, end + 1),
				type: { status: "known", display: joinType(this.tokens, typeIndexes, this.angles) || "type" },
				templateDependent: scope.templateDependent,
				parameterNames: new Set(),
				...this.typeReference(typeIndexes),
			});
			this.addTemplateParameters(prefix.template, alias, scope);
			return end + 1;
		}
		this.markRoleAfter(prefix.keywordIndex, end, "import");
		for (const declarator of this.declaratorSegments(prefix.keywordIndex + 1, end)) {
			const name = this.lastNameIn(declarator.start - 1, declarator.end);
			using(name, true);
			const transfer = transfers ? this.declaratorTransfer(declarator.start, declarator.end, name) : null;
			if (transfer !== null) this.transfers.push(transfer);
		}
		return end + 1;
	}

	/** `N::x` in a using-declaration, a name taken from `N`; null when `name` is not the declarator's last word. */
	private declaratorTransfer(from: number, to: number, name: number): TransferDraft | null {
		if (name < 0 || significantAfter(this.tokens, name, to) >= 0) return null;
		const first = significantAfter(this.tokens, from - 1, to);
		const colons = significantBefore(this.tokens, name);
		if (tokenAt(this.tokens, colons)?.text !== "::") return null;
		return {
			kind: "named",
			specifier: colons === first ? "::" : joinTokens(this.tokens, first, colons),
			span: rangeFrom(this.tokens, first, name + 1) as Range,
			tokenStart: first,
			lastName: name,
			name: this.writtenName(name),
		};
	}

	/** From `first` through the `;` at `end`, else through `last`. */
	private spanThrough(first: number, end: number, last: number): Range {
		const close = tokenAt(this.tokens, end)?.text === ";" ? end : last;
		return rangeFrom(this.tokens, first, close + 1) as Range;
	}

	private writtenName(index: number): { text: string; range: Range } {
		const token = tokenAt(this.tokens, index) as Token;
		return { text: token.value, range: rangeOfToken(token) };
	}

	/** The last name in `(from, to)` outside template arguments, keywords left out; -1 when none. */
	private lastNameIn(from: number, to: number): number {
		let last = -1;
		let templates = 0;
		for (let index = from + 1; index < to; index++) {
			const token = tokenAt(this.tokens, index);
			templates = Math.max(0, templates + bracketDelta(token, this.angles));
			if (templates === 0 && token?.kind === "identifier" && !KEYWORDS.has(token.value)) last = index;
		}
		return last;
	}

	/** `typedef` and its declarators, each an alias; a class or enum body in it declares its members. */
	private parseTypedef(prefix: Prefix, limit: number, scope: Scope, access: Visibility): number {
		const end = statementEnd(this.tokens, prefix.startIndex, limit);
		const contentStart = significantAfter(this.tokens, prefix.keywordIndex, limit);
		let key = contentStart;
		while (tokenAt(this.tokens, key)?.text === "const" || tokenAt(this.tokens, key)?.text === "volatile")
			key = significantAfter(this.tokens, key, limit);
		const keyword = tokenAt(this.tokens, key)?.text ?? "";
		if (CLASS_KEYS.has(keyword)) {
			const own: Prefix = { ...prefix, keywordIndex: key };
			const next =
				keyword === "enum"
					? this.parseEnum(own, limit, scope, access, true)
					: this.parseClass(own, limit, scope, access, true);
			if (next !== null) return next;
		}
		const [head, ...later] = contentStart < 0 ? [] : this.declaratorSegments(contentStart, end + 1);
		const site = head === undefined ? null : this.declaratorIn(head.start, head.end);
		if (head === undefined || site === null) {
			this.addDiagnostic("Typedef declaration needs a name.", prefix.keywordIndex);
			return end + 1;
		}
		const statement: DeclarationStatement = {
			start: prefix.startIndex,
			specifiers: { start: contentStart, end: site.start },
			scope: scope.kind === "class" ? { ...scope, defaultVisibility: access } : scope,
			prefix,
		};
		this.addAlias(statement, site, head, false);
		for (const segment of later) {
			const next = this.declaratorIn(segment.start, segment.end);
			if (next !== null && this.significantIndexes(segment.start, next.start).length === 0)
				this.addAlias(statement, next, segment, true);
		}
		return end + 1;
	}

	/** One typedef declarator as an alias of the statement's type. */
	private addAlias(
		statement: DeclarationStatement,
		site: DeclaratorSite,
		segment: TokenSpan,
		later: boolean,
		extra: Partial<DraftInput> = {},
	): DraftRecord {
		const { scope, prefix } = statement;
		const typeIndexes = [
			...this.significantIndexes(statement.specifiers.start, statement.specifiers.end),
			...this.declaratorTypeIndexes(site),
		];
		for (const typeIndex of typeIndexes)
			if (tokenAt(this.tokens, typeIndex)?.kind === "identifier") this.typeTokenIndexes.add(typeIndex);
		const nameIndex = site.name;
		const name = tokenAt(this.tokens, nameIndex)?.value ?? "Alias";
		const end = Math.max(nameIndex + 1, segment.end);
		const lead = statement.lead ?? { start: statement.start, end: statement.specifiers.end };
		return this.addDraft({
			parent: scope.parent,
			own: { kind: "type", name },
			kind: "class",
			name,
			visibility: this.visibilityFor(scope, prefix?.modifiers ?? new Set(), scope.defaultVisibility),
			languageKind: "typedef",
			exported: prefix?.exported ?? false,
			startIndex: statement.start,
			endIndex: end,
			nameStartIndex: nameIndex,
			nameEndIndex: nameIndex + 1,
			signature: later
				? this.header(segment.start, end, "type", lead)
				: this.header(statement.start, end, "type"),
			metrics: this.metrics.of(statement.start, end),
			type: { status: "known", display: joinType(this.tokens, typeIndexes, this.angles) || "type" },
			templateDependent: scope.templateDependent,
			parameterNames: new Set(),
			...this.typeReference(typeIndexes, this.arrayRanks(site.end, segment.end), statement.declared),
			...extra,
		});
	}

	/** `concept Name = constraint;`, a named set of requirements. */
	private parseConcept(prefix: Prefix, limit: number, scope: Scope, access: Visibility): number {
		const end = statementEnd(this.tokens, prefix.keywordIndex, limit);
		const nameIndex = significantAfter(this.tokens, prefix.keywordIndex, end);
		if (!isNameToken(tokenAt(this.tokens, nameIndex))) return end + 1;
		const name = tokenAt(this.tokens, nameIndex)?.value ?? "Concept";
		const record = this.addDraft({
			parent: scope.parent,
			own: { kind: "type", name },
			kind: "interface",
			name,
			visibility: this.visibilityFor(scope, prefix.modifiers, access),
			languageKind: "concept",
			exported: prefix.exported,
			startIndex: prefix.startIndex,
			endIndex: end + 1,
			nameStartIndex: nameIndex,
			nameEndIndex: nameIndex + 1,
			signature: this.header(prefix.startIndex, end + 1, "type"),
			metrics: this.metrics.of(prefix.startIndex, end + 1),
			templateDependent: this.templateDependent(scope, prefix),
			parameterNames: new Set(),
		});
		this.addTemplateParameters(prefix.template, record, scope);
		return end + 1;
	}

	/** Past one more level of nesting; false, with one problem reported, past the limit. */
	protected enterNesting(at: number): boolean {
		if (this.nesting >= MAX_NESTING) {
			this.addDiagnostic(TOO_DEEP, at);
			return false;
		}
		this.nesting++;
		return true;
	}

	/** The closing brace's line when nothing precedes it there; undefined when it is missing or shares its line. */
	private memberInsertLine(close: number): number | undefined {
		const closer = tokenAt(this.tokens, close);
		if (closer === undefined) return undefined;
		let previous = close - 1;
		while (tokenAt(this.tokens, previous)?.kind === "newline") previous--;
		const before = tokenAt(this.tokens, previous);
		return before === undefined || before.end.line < closer.start.line ? closer.start.line : undefined;
	}

	private markRoleAfter(startIndex: number, endIndex: number, role: Reference["role"]): void {
		for (let index = startIndex + 1; index < endIndex; index++) {
			const token = tokenAt(this.tokens, index);
			if (token?.kind === "identifier" && !KEYWORDS.has(token.value)) this.roleByToken.set(index, role);
		}
	}

	/**
	 * Each base's name, the last one written outside template arguments; the name itself extends,
	 * the rest are type uses.
	 */
	private readClassBases(startIndex: number, bodyIndex: number): number[] {
		const colon = this.findNextText(startIndex, ":", bodyIndex);
		if (colon < 0) return [];
		const bases: number[] = [];
		for (const segment of this.declaratorSegments(colon + 1, bodyIndex)) {
			let last = -1;
			let templates = 0;
			for (let index = segment.start; index < segment.end; index++) {
				const token = tokenAt(this.tokens, index);
				templates = Math.max(0, templates + bracketDelta(token, this.angles));
				if (token?.kind !== "identifier" || KEYWORDS.has(token.value)) continue;
				if (!this.roleByToken.has(index)) this.roleByToken.set(index, "typeUse");
				if (templates === 0) last = index;
			}
			if (last < 0) continue;
			this.roleByToken.set(last, "extends");
			bases.push(last);
		}
		return bases;
	}
}
