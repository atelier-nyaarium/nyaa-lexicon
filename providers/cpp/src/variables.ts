// Simple declarations: the specifiers, then each declarator as a variable, field or constant, and
// the names a structured binding introduces.

import type { Declaration } from "@nyaa-lexicon/protocol";
import { type DeclaratorSite, isAssignment } from "./declarators.js";
import { CppDraftTable, TYPE_KINDS } from "./drafts.js";
import type { TokenSpan } from "./header.js";
import type { DraftRecord, Prefix, Scope, Visibility } from "./model.js";
import { divergence, withinGroup } from "./tokens.js";
import { statementEnd, tokenAt } from "./tokenWalk.js";
import { draftTypeFor, formatType, isAutoType, unknownTemplateType } from "./typeText.js";
import { isNameToken, isShoutCase } from "./words.js";

////////////////////////////////
//  Interfaces & Types

/** A simple declaration every declarator in it shares. */
export interface DeclarationStatement {
	/** Its first token: a template head, an attribute or the first specifier. */
	start: number;
	/** The specifiers naming the declarators' type. */
	specifiers: TokenSpan;
	/** What a later declarator's header shows before it; the statement up to `specifiers` when absent. */
	lead?: TokenSpan;
	scope: Scope;
	prefix: Prefix | undefined;
	/** The class or enum its specifiers define, the declarators' type. */
	declared?: DraftRecord;
}

////////////////////////////////
//  Constants

/** Words that open a statement no declaration starts with. */
const STATEMENT_KEYWORDS: ReadonlySet<string> = new Set([
	"return",
	"throw",
	"if",
	"else",
	"for",
	"while",
	"switch",
	"case",
	"break",
	"continue",
	"goto",
	"using",
	"namespace",
	"static_assert",
	"typedef",
]);

////////////////////////////////
//  Classes

/** Declares a simple declaration's declarators; a function among them is the subclass's to read. */
export abstract class CppVariableParser extends CppDraftTable {
	/** Every lambda in `[start, end)`, its locals declared in `scope`. */
	protected abstract walkLambdas(start: number, end: number, scope: Scope): void;

	/** A function declarator; a later one in a list, `int a, f();`, names the `statement` it shares. */
	protected abstract parseFunction(
		prefix: Prefix,
		openIndex: number,
		limit: number,
		scope: Scope,
		access: Visibility,
		statement?: DeclarationStatement,
	): number;

	protected parseVariableStatement(prefix: Prefix, endIndex: number, scope: Scope, access: Visibility): void {
		this.parseVariableRange(
			prefix.startIndex,
			endIndex,
			scope.kind === "class" ? { ...scope, defaultVisibility: access } : scope,
			prefix,
		);
	}

	/**
	 * A simple declaration from `startIndex` to past its `;` at `endIndex`: the specifiers, then each
	 * declarator. `int a = 1, *b;` declares both; at namespace and class scope a later `g()` is a
	 * function.
	 */
	protected parseVariableRange(
		startIndex: number,
		endIndex: number,
		scope: Scope,
		prefix?: Prefix,
		declarationOnly = false,
	): void {
		const first = this.significantIndexes(startIndex, endIndex)[0] ?? -1;
		const firstValue = tokenAt(this.tokens, first)?.text;
		if (first < 0 || firstValue === undefined || STATEMENT_KEYWORDS.has(firstValue)) return;
		const contentStart = prefix?.keywordIndex ?? first;
		const statementStart = prefix?.startIndex ?? first;
		const [head, ...later] = this.declaratorSegments(contentStart, endIndex);
		if (head === undefined) return;
		const bindings = this.structuredBinding(contentStart, head.end);
		if (bindings !== null) {
			if (this.specifierShape(contentStart, bindings.start).typed)
				this.addBindings(bindings, statementStart, head.end, scope, prefix);
			return;
		}
		const site = this.declaratorIn(head.start, head.end);
		if (site === null || !this.declares(contentStart, site, scope, declarationOnly)) return;
		const statement: DeclarationStatement = {
			start: statementStart,
			specifiers: { start: contentStart, end: site.start },
			scope,
			prefix,
		};
		this.addDeclarator(statement, site, head, false);
		this.addLaterDeclarators(statement, later);
		this.addAlternativeDeclarators(statement, endIndex - 1);
	}

	/**
	 * Declarators that other `#if` alternatives write after the statement's `;` for the specifiers
	 * standing before the group: `int` then `#if A *p; #else p; #endif` declares `p` in each branch.
	 */
	private addAlternativeDeclarators(statement: DeclarationStatement, semicolon: number): void {
		const shared = this.significantIndexes(statement.specifiers.start, statement.specifiers.end);
		const lead = { start: statement.start, end: statement.specifiers.end };
		let end = semicolon;
		for (let guard = -1; tokenAt(this.tokens, end)?.text === ";"; ) {
			if (end <= guard) throw new Error("alternative declarator scan failed to advance");
			guard = end;
			const next = this.codeAfter(end);
			const fork = divergence(tokenAt(this.tokens, next)?.alternative, tokenAt(this.tokens, end)?.alternative);
			if (
				fork === undefined ||
				shared.some((index) => withinGroup(tokenAt(this.tokens, index)?.alternative, fork.group))
			)
				return;
			end = statementEnd(this.tokens, next, this.tokens.length);
			const own = divergence(tokenAt(this.tokens, end)?.alternative, tokenAt(this.tokens, next)?.alternative);
			if (own !== undefined) return;
			for (const segment of this.declaratorSegments(next, end + 1)) {
				const site = this.declaratorIn(segment.start, segment.end);
				if (site === null || this.significantIndexes(segment.start, site.start).length > 0) return;
				this.addDeclarator({ ...statement, lead }, site, segment, true);
			}
		}
	}

	/** Each declarator after the first, sharing the first's specifiers. */
	protected addLaterDeclarators(statement: DeclarationStatement, segments: TokenSpan[]): void {
		const { scope, prefix } = statement;
		for (const segment of segments) {
			const site = this.declaratorIn(segment.start, segment.end);
			if (site === null || this.significantIndexes(segment.start, site.start).length > 0) continue;
			if (site.call >= 0 && scope.kind !== "function" && prefix !== undefined) {
				const own: Prefix = { ...prefix, keywordIndex: segment.start, template: null };
				this.parseFunction(own, site.call, segment.end, scope, scope.defaultVisibility, statement);
				continue;
			}
			this.addDeclarator(statement, site, segment, true);
		}
	}

	/**
	 * Whether specifiers before `site` declare it. At namespace and class scope any type does. In a
	 * body, names and pointer operators also spell expressions, so `a * b` and `f(*p)` need a type
	 * the reader can tell apart: a keyword, a qualified or templated name, or one declared here. An
	 * initializer tells `T* p = q` apart too, unless `T` is a value in view. What `T` names is what
	 * the nearest scope around it declares it as. Where only a declaration stands, a range-for's or a
	 * handler's, any type does.
	 */
	private declares(contentStart: number, site: DeclaratorSite, scope: Scope, declarationOnly: boolean): boolean {
		const shape = this.specifierShape(contentStart, site.start);
		if (!shape.clean || !shape.typed) return false;
		if (scope.kind !== "function" || declarationOnly || site.start === site.qualifierStart) return true;
		const name = shape.firstName;
		const seen = name === undefined ? undefined : this.declaredKind(name, scope, site.start);
		const named = name !== undefined && (this.typeNames.has(name) || isShoutCase(name));
		const typed = shape.keyworded || shape.compound || seen === "type" || (seen === undefined && named);
		if (typed || site.call >= 0 || site.nested >= 0) return typed;
		const initializer = tokenAt(this.tokens, site.end)?.text;
		return (initializer === "=" || initializer === "{") && seen !== "value";
	}

	/** One declarator of `statement` as a variable, field or constant, over `segment`. */
	protected addDeclarator(
		statement: DeclarationStatement,
		site: DeclaratorSite,
		segment: TokenSpan,
		later: boolean,
	): void {
		const { scope, prefix } = statement;
		const specifiers = this.significantIndexes(statement.specifiers.start, statement.specifiers.end);
		const typeIndexes = [...specifiers, ...this.declaratorTypeIndexes(site)];
		for (const typeIndex of typeIndexes)
			if (tokenAt(this.tokens, typeIndex)?.kind === "identifier") this.typeTokenIndexes.add(typeIndex);
		const nameIndex = site.name;
		const name = tokenAt(this.tokens, nameIndex)?.value ?? "value";
		const qualifier = this.writtenQualifier(site.qualifierStart, nameIndex);
		const qualifiedParent =
			scope.kind === "function" ? null : this.findQualifiedParent(qualifier, scope, nameIndex);
		const equals = this.topLevelStop(site.end - 1, segment.end, isAssignment);
		const initializerStart = equals < segment.end ? equals + 1 : segment.end;
		const declarationStart = statement.start;
		const declarationEnd = Math.max(nameIndex + 1, segment.end);
		const declaredMember = this.declaredIn
			.get(qualifiedParent)
			?.get(name)
			?.find((draft) => qualifiedParent !== null && draft.own.kind === "term");
		if (declaredMember !== undefined) {
			// A static member defined outside its class: the definition is the member's declaration.
			this.roleByToken.set(declaredMember.nameStartIndex, "read");
			this.prototypes.set(declaredMember.nameStartIndex, declaredMember);
			declaredMember.declaredAt = Math.min(
				declaredMember.declaredAt ?? declaredMember.nameStartIndex,
				declaredMember.nameStartIndex,
			);
			declaredMember.startIndex = declarationStart;
			declaredMember.endIndex = declarationEnd;
			declaredMember.nameStartIndex = nameIndex;
			declaredMember.nameEndIndex = nameIndex + 1;
			declaredMember.signature = this.header(declarationStart, declarationEnd, "value");
			declaredMember.metrics = this.metrics.of(declarationStart, declarationEnd);
			this.excludedTokenIndexes.add(nameIndex);
			return;
		}
		const parent = qualifiedParent ?? scope.parent;
		const qualifierNames = qualifiedParent === null && scope.kind !== "function" ? qualifier : [];
		const modifiers = prefix?.modifiers ?? new Set<string>();
		const isConstant =
			modifiers.has("const") ||
			modifiers.has("constexpr") ||
			modifiers.has("constinit") ||
			typeIndexes.some(
				(index) =>
					tokenAt(this.tokens, index)?.text === "const" || tokenAt(this.tokens, index)?.text === "constexpr",
			);
		const member = scope.kind === "class" || parent?.kind === "class" || parent?.kind === "struct";
		const kind: Declaration["kind"] = member ? "field" : isConstant ? "constant" : "variable";
		const visibility =
			scope.kind === "function" ? "local" : this.visibilityFor(scope, modifiers, scope.defaultVisibility);
		const typeText = formatType(this.tokens, typeIndexes, this.angles);
		// An `auto` type is the initializer's.
		const spelled = isAutoType(typeText)
			? [...typeIndexes, ...this.significantIndexes(initializerStart, segment.end)]
			: typeIndexes;
		const templateDependent =
			prefix === undefined ? scope.templateDependent : this.templateDependent(scope, prefix);
		const dependent =
			templateDependent && this.dependentType(spelled, this.templateNamesIn(scope.parent, prefix?.template));
		const type = dependent
			? unknownTemplateType("template-dependent variable type is not resolved")
			: draftTypeFor(typeText, this.tokens, initializerStart, segment.end);
		const lead = statement.lead ?? { start: statement.start, end: statement.specifiers.end };
		const initialized = equals < segment.end || tokenAt(this.tokens, site.end)?.text === "{";
		const record = this.addDraft({
			parent,
			...(qualifierNames.length === 0 ? {} : { qualifierNames }),
			own: { kind: "term", name },
			kind,
			name,
			visibility,
			languageKind: isConstant ? "constant" : undefined,
			exported: prefix?.exported ?? false,
			startIndex: declarationStart,
			endIndex: declarationEnd,
			nameStartIndex: nameIndex,
			nameEndIndex: nameIndex + 1,
			signature: later
				? this.header(segment.start, declarationEnd, "value", lead)
				: this.header(declarationStart, declarationEnd, "value"),
			metrics: this.metrics.of(declarationStart, declarationEnd),
			type,
			templateDependent: scope.templateDependent,
			parameterNames: new Set(),
			...(!initialized &&
			(modifiers.has("extern") || specifiers.some((index) => tokenAt(this.tokens, index)?.text === "extern"))
				? { declarationOnly: true }
				: {}),
			...this.typeReference(typeIndexes, this.arrayRanks(site.end, segment.end), statement.declared),
			...this.visibleScope(scope),
		});
		if (!later) this.addTemplateParameters(prefix?.template ?? null, record, scope);
		// Outside a body, a lambda in the initializer keeps its locals under this declaration.
		if (scope.kind !== "function")
			this.walkLambdas(site.end, segment.end, {
				parent: record,
				kind: "function",
				defaultVisibility: "local",
				templateDependent: scope.templateDependent,
			});
	}

	/** Each name a structured binding introduces, as a variable over the whole statement. */
	private addBindings(
		bindings: TokenSpan,
		statementStart: number,
		statementEnd: number,
		scope: Scope,
		prefix: Prefix | undefined,
	): void {
		for (let index = bindings.start + 1; index < bindings.end; index++) {
			const token = tokenAt(this.tokens, index);
			if (!isNameToken(token)) continue;
			const name = token?.value ?? "binding";
			this.addDraft({
				parent: scope.parent,
				own: { kind: "term", name },
				kind: scope.kind === "class" ? "field" : "variable",
				name,
				visibility:
					scope.kind === "function"
						? "local"
						: this.visibilityFor(scope, prefix?.modifiers ?? new Set(), scope.defaultVisibility),
				languageKind: "structured binding",
				exported: prefix?.exported ?? false,
				startIndex: statementStart,
				endIndex: statementEnd,
				nameStartIndex: index,
				nameEndIndex: index + 1,
				signature: this.header(statementStart, statementEnd, "value"),
				metrics: this.metrics.of(statementStart, statementEnd),
				type: unknownTemplateType("a structured binding's type is not inferred"),
				templateDependent: scope.templateDependent,
				parameterNames: new Set(),
				...this.visibleScope(scope),
			});
		}
	}

	/**
	 * What `name` is where the reader stands at `at`: the nearest scope around it that declares the
	 * name decides, a type or a value. Undefined when none does.
	 */
	private declaredKind(name: string, scope: Scope, at: number): "type" | "value" | undefined {
		for (let owner = scope.parent; ; owner = owner.parent) {
			// A class's own name in it is the class, not its constructors.
			if (owner !== null && owner.name === name && (owner.kind === "class" || owner.kind === "struct"))
				return "type";
			const found = (this.declaredIn.get(owner)?.get(name) ?? []).filter(
				(draft) =>
					draft.kind !== "constructor" &&
					draft.nameStartIndex < at &&
					(draft.visibleEnd === undefined || draft.visibleEnd < 0 || at < draft.visibleEnd),
			);
			if (found.length > 0) return found.some((draft) => TYPE_KINDS.has(draft.kind)) ? "type" : "value";
			if (owner === null) return undefined;
		}
	}
}
