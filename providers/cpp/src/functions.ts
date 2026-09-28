// Function declarations: overload identity, prototypes merged into their definitions, return types
// and parameters.

import { listAt, mapAt } from "./collections.js";
import { isAssignment } from "./declarators.js";
import { writtenPath } from "./drafts.js";
import type { DraftRecord, DraftType, Prefix, Scope, TemplateInfo, Visibility } from "./model.js";
import { exclusive } from "./tokens.js";
import { matching, significantAfter, statementEnd, tokenAt } from "./tokenWalk.js";
import {
	canonicalType,
	formatType,
	functionQualifiers,
	inferExpressionType,
	isAutoType,
	unknownTemplateType,
} from "./typeText.js";
import { CppVariableParser, type DeclarationStatement } from "./variables.js";
import { MODIFIERS } from "./words.js";

////////////////////////////////
//  Interfaces & Types

/** A declared type and the tokens spelling it. */
interface TypeRead {
	type: { status: "known"; display: string };
	indexes: number[];
}

////////////////////////////////
//  Constants

/** What ends a trailing return type before the body or the declaration's end. */
const TRAILING_TYPE_ENDS: ReadonlySet<string> = new Set(["=", "override", "final", "requires"]);

/** Words after `operator` that name an operator, not a conversion's type. */
const NON_CONVERSIONS: ReadonlySet<string> = new Set(["new", "delete", "co_await"]);

////////////////////////////////
//  Classes

/** Declares functions and their parameters; a function body's statements are the subclass's to walk. */
export abstract class CppFunctionParser extends CppVariableParser {
	protected readonly trailingReturnArrows = new Set<number>();

	/** Functions by parent, a namespace's openings as one, then name, parameters and written qualifier. */
	private readonly functionsByKey = new Map<DraftRecord | string | null, Map<string, DraftRecord[]>>();

	/** Each function's own template head without names and defaults. */
	private readonly functionHeads = new Map<DraftRecord, string>();

	/** Each function parameter's position in its list. */
	private readonly parameterPositions = new Map<DraftRecord, number>();

	/** A function body between its braces; its locals belong to `owner`. */
	protected abstract parseBody(start: number, close: number, owner: DraftRecord, templateDependent: boolean): void;

	/** `catch` handlers from `index`; the index past the last. */
	protected abstract walkHandlers(index: number, limit: number, scope: Scope): number;

	/**
	 * A function declarator whose parameter list opens at `openIndex`. A later declarator in a list,
	 * `int f(), g();`, names the `statement` it shares specifiers with.
	 */
	protected parseFunction(
		prefix: Prefix,
		openIndex: number,
		limit: number,
		scope: Scope,
		access: Visibility,
		statement?: DeclarationStatement,
	): number {
		const nameInfo = this.functionName(openIndex, prefix);
		if (nameInfo === null) return prefix.startIndex;
		const close = matching(this.tokens, openIndex, "(", ")", limit);
		if (close < 0) {
			this.addDiagnostic("Function parameter list is not closed.", openIndex);
			return limit;
		}
		const bodyOrEnd = this.functionTail(close, limit);
		const body = bodyOrEnd.body;
		const bodyClose = body < 0 ? -1 : matching(this.tokens, body, "{", "}", limit);
		const listed = body < 0 && tokenAt(this.tokens, bodyOrEnd.end)?.text === ",";
		const declarationEnd =
			body >= 0
				? this.optionalSemicolon(bodyOrEnd.tryBlock ? this.handlersEnd(bodyClose, limit) : bodyClose, limit)
				: listed
					? bodyOrEnd.end
					: bodyOrEnd.end + 1;
		const headerStart = statement === undefined ? prefix.startIndex : prefix.keywordIndex;
		const lead =
			statement === undefined
				? undefined
				: (statement.lead ?? { start: statement.start, end: statement.specifiers.end });
		const qualifiedParent = this.findQualifiedParent(nameInfo.qualifier, scope, nameInfo.nameStartIndex);
		const parent = qualifiedParent ?? scope.parent;
		const member = parent?.kind === "class" || parent?.kind === "struct";
		const isConstructor = member && (nameInfo.name === parent?.name || nameInfo.name.startsWith("~"));
		const operator = nameInfo.name.startsWith("operator");
		const templateDependent = this.templateDependent(scope, prefix);
		const shared =
			statement === undefined
				? []
				: this.significantIndexes(statement.specifiers.start, statement.specifiers.end).filter(
						(index) => !MODIFIERS.has(tokenAt(this.tokens, index)?.text ?? ""),
					);
		const returnRead =
			this.functionReturnType(prefix, nameInfo, close, bodyOrEnd.end, shared) ??
			this.conversionType(nameInfo.nameStartIndex, openIndex);
		const returnInfo = returnRead?.type;
		const returnType =
			templateDependent &&
			(returnRead === undefined ||
				this.dependentType(returnRead.indexes, this.templateNamesIn(parent, prefix.template)))
				? unknownTemplateType("template-dependent return type is not resolved")
				: returnInfo;
		const friend = prefix.modifiers.has("friend");
		if (friend && body < 0) {
			// A friend's prototype names a function declared outside the class.
			this.roleByToken.set(nameInfo.nameStartIndex, "read");
			this.markParameterTypes(openIndex + 1, close);
			return declarationEnd;
		}
		const qualifierNames = qualifiedParent === null ? nameInfo.qualifier : [];
		// `B<T>::` takes a head of its own, so only a head past those is the function's.
		const classHeads = nameInfo.templatedQualifiers;
		const own = classHeads > 0 && prefix.heads.length <= classHeads ? null : prefix.template;
		const enclosing =
			classHeads > 0
				? prefix.heads
						.slice(0, classHeads)
						.reverse()
						.map((head) => head.parameters.map((parameter) => parameter.name))
				: this.enclosingTemplateNames(parent);
		const positions = this.templatePositions(own, enclosing);
		const parameterSignature = `${this.canonicalParameters(openIndex + 1, close, positions)})${functionQualifiers(this.tokens, close + 1, bodyOrEnd.end)}`;
		const overload = JSON.stringify([nameInfo.name, parameterSignature, qualifierNames]);
		const head = this.canonicalHead(own, positions);
		const owner = parent?.kind === "namespace" ? writtenPath(parent).join("::") : parent;
		const overloads = listAt(mapAt(this.functionsByKey, owner), overload);
		// Templates alike but for their heads, as SFINAE overloads, are distinct, and so are declarations
		// in different branches of one `#if` group.
		const alternative = tokenAt(this.tokens, nameInfo.nameStartIndex)?.alternative;
		const found = overloads.find(
			(candidate) =>
				this.functionHeads.get(candidate) === head &&
				!exclusive(tokenAt(this.tokens, candidate.nameStartIndex)?.alternative, alternative),
		);
		// A second body, such as another explicit specialization's, is a declaration of its own.
		const existing = found?.hasBody && body >= 0 ? undefined : found;
		const returned = returnRead === undefined ? {} : this.typeReference(returnRead.indexes);
		const record =
			existing ??
			this.addDraft({
				parent,
				...(qualifierNames.length === 0 ? {} : { qualifierNames }),
				own: { kind: "method", name: nameInfo.name },
				// A friend defined in a class is no member of it, and no access label reaches it.
				kind: operator ? "operator" : isConstructor ? "constructor" : member && !friend ? "method" : "function",
				name: nameInfo.name,
				visibility: friend ? "public" : this.visibilityFor(scope, prefix.modifiers, access),
				languageKind: nameInfo.name.startsWith("operator")
					? "operator"
					: nameInfo.name.startsWith("~")
						? "destructor"
						: undefined,
				exported: prefix.exported,
				startIndex: prefix.startIndex,
				endIndex: Math.max(prefix.startIndex + 1, declarationEnd),
				nameStartIndex: nameInfo.nameStartIndex,
				nameEndIndex: nameInfo.nameEndIndex,
				signature: this.header(headerStart, body >= 0 ? body : bodyOrEnd.end + 1, "value", lead),
				metrics: this.metrics.of(prefix.startIndex, Math.max(prefix.startIndex + 1, declarationEnd)),
				type: returnType,
				templateDependent,
				parameterNames: new Set(),
				parameterSignature,
				hasBody: body >= 0,
				...returned,
			});
		if (found === undefined) {
			overloads.push(record);
			this.functionHeads.set(record, head);
		}
		const prototypeSpan = { start: existing?.startIndex ?? 0, end: existing?.endIndex ?? 0 };
		if (existing !== undefined && body >= 0) {
			this.roleByToken.set(existing.nameStartIndex, "read");
			this.prototypes.set(existing.nameStartIndex, existing);
			// The definition's own name is the declaration, not a use of it.
			for (let index = nameInfo.nameStartIndex; index < nameInfo.nameEndIndex; index++)
				this.excludedTokenIndexes.add(index);
			existing.declaredAt = Math.min(existing.declaredAt ?? existing.nameStartIndex, existing.nameStartIndex);
			Object.assign(existing, returned);
			existing.startIndex = prefix.startIndex;
			existing.endIndex = Math.max(prefix.startIndex + 1, declarationEnd);
			existing.nameStartIndex = nameInfo.nameStartIndex;
			existing.nameEndIndex = nameInfo.nameEndIndex;
			existing.signature = this.header(prefix.startIndex, body, "value");
			existing.metrics = this.metrics.of(prefix.startIndex, Math.max(prefix.startIndex + 1, declarationEnd));
			existing.hasBody = true;
			existing.type = returnType;
		} else if (existing !== undefined) {
			this.roleByToken.set(nameInfo.nameStartIndex, "read");
			this.prototypes.set(nameInfo.nameStartIndex, existing);
			this.markParameterTypes(openIndex + 1, close);
		}
		if (existing === undefined) this.addTemplateParameters(prefix.template, record, scope);
		else if (body >= 0 && own !== null) {
			const renamed = this.redeclare(existing, "typeParameter", () =>
				this.addTemplateParameters(own, existing, scope),
			);
			// The prototype's uses of its own head's names are uses of the definition's.
			for (let index = prototypeSpan.start; index < prototypeSpan.end; index++) {
				const token = tokenAt(this.tokens, index);
				const pair = renamed.find(
					([earlier]) => earlier.name === token?.value && earlier.nameStartIndex !== index,
				);
				if (token?.kind === "identifier" && pair !== undefined) this.prototypes.set(index, pair[1]);
			}
		}
		const parameterCount =
			existing === undefined
				? this.parseParameters(openIndex + 1, close, record)
				: body >= 0
					? this.redeclareParameters(existing, openIndex + 1, close)
					: this.countParameters(openIndex + 1, close);
		if (record.metrics !== undefined) record.metrics = { ...record.metrics, parameters: parameterCount };
		// A body outside an `#if` group completes the prototype each branch of it writes, the head
		// before `#else` of a body after `#endif` included.
		const bodyAlternative = tokenAt(this.tokens, body)?.alternative;
		if (body >= 0)
			for (const other of overloads)
				if (
					other !== record &&
					!other.hasBody &&
					other.mergedInto === undefined &&
					this.functionHeads.get(other) === head &&
					!exclusive(tokenAt(this.tokens, other.nameStartIndex)?.alternative, bodyAlternative)
				)
					this.completes(record, other);
		if (body >= 0) {
			if (bodyClose < 0) this.addDiagnostic("Function body is not closed.", body);
			else {
				this.parseBody(body + 1, bodyClose, record, templateDependent);
				if (bodyOrEnd.tryBlock)
					this.walkHandlers(bodyClose + 1, declarationEnd, {
						parent: record,
						kind: "function",
						defaultVisibility: "local",
						templateDependent,
					});
				if (!templateDependent && returnInfo === undefined && this.hasAutoReturn(prefix, nameInfo))
					this.addTemplateReturnInference(record, body + 1, bodyClose);
			}
		}
		if (listed && statement === undefined) {
			const end = statementEnd(this.tokens, bodyOrEnd.end + 1, limit);
			const first: DeclarationStatement = {
				start: prefix.startIndex,
				specifiers: {
					start: prefix.keywordIndex,
					end: this.pointerStartOf(nameInfo.qualifierStart, prefix.keywordIndex),
				},
				scope: scope.kind === "class" ? { ...scope, defaultVisibility: access } : scope,
				prefix,
			};
			this.addLaterDeclarators(first, this.declaratorSegments(bodyOrEnd.end + 1, end + 1));
			return end + 1;
		}
		return Math.max(prefix.startIndex + 1, declarationEnd);
	}

	/** The declared return type; `shared` holds the specifiers a later declarator in a list shares. */
	private functionReturnType(
		prefix: Prefix,
		nameInfo: { nameStartIndex: number; qualifierStart: number },
		closeIndex: number,
		headerEnd: number,
		shared: number[] = [],
	): TypeRead | undefined {
		// A member initializer list ends the search: an arrow there is an expression's.
		const found = this.topLevelStop(closeIndex, headerEnd, (value) => value === "->" || value === ":");
		const arrow = found < headerEnd && tokenAt(this.tokens, found)?.text === "->" ? found : -1;
		if (arrow >= 0) {
			this.trailingReturnArrows.add(arrow);
			const trailingEnd = this.topLevelStop(arrow, headerEnd, (value) => TRAILING_TYPE_ENDS.has(value));
			const typeIndexes = this.significantIndexes(arrow + 1, trailingEnd);
			for (const typeIndex of typeIndexes)
				if (tokenAt(this.tokens, typeIndex)?.kind === "identifier") this.typeTokenIndexes.add(typeIndex);
			return this.typeRead(typeIndexes);
		}
		const returnIndexes = [...shared, ...this.significantIndexes(prefix.keywordIndex, nameInfo.qualifierStart)];
		const filtered = returnIndexes.filter((index) => !MODIFIERS.has(tokenAt(this.tokens, index)?.text ?? ""));
		for (const typeIndex of filtered)
			if (tokenAt(this.tokens, typeIndex)?.kind === "identifier") this.typeTokenIndexes.add(typeIndex);
		const read = this.typeRead(filtered);
		return read === undefined || isAutoType(read.type.display) ? undefined : read;
	}

	/**
	 * A template head as overload identity: each parameter's kind and type, names and defaults
	 * dropped, types naming parameters by `positions`. `<>` for an explicit specialization's.
	 */
	private canonicalHead(template: TemplateInfo | null, positions: ReadonlyMap<string, string>): string {
		if (template === null) return "";
		const open = significantAfter(this.tokens, template.startIndex);
		const close = template.endIndex - 1;
		const names = new Set(template.parameters.map((parameter) => parameter.nameStartIndex));
		const segments = this.declaratorSegments(open + 1, close);
		const parts = segments.map((segment) => {
			const stop = this.topLevelStop(segment.start - 1, segment.end, isAssignment);
			const indexes = this.significantIndexes(segment.start, stop).filter((index) => !names.has(index));
			return canonicalType(this.tokens, indexes, this.angles, positions);
		});
		const last = segments.at(-1);
		// A `>>` closing the head closes its last parameter's list too, unless that sat in a dropped default.
		if (tokenAt(this.tokens, close)?.text === ">>" && last !== undefined && parts.length > 0) {
			const defaulted = this.topLevelStop(last.start - 1, last.end, isAssignment) < last.end;
			if (!defaulted) parts.push(`${parts.pop()} >`);
		}
		return `<${parts.filter((part) => part !== "").join(",")}>`;
	}

	/** A parameter list as overload identity: each parameter's type, its name and default dropped. */
	private canonicalParameters(start: number, limit: number, positions: ReadonlyMap<string, string>): string {
		const parts: string[] = [];
		for (const segment of this.declaratorSegments(start, limit)) {
			const stop = this.topLevelStop(segment.start - 1, segment.end, isAssignment);
			const site = this.declaratorIn(segment.start, stop);
			const name = site !== null && this.specifierShape(segment.start, site.start).typed ? site.name : -1;
			const indexes = this.significantIndexes(segment.start, stop).filter((index) => index !== name);
			const part = canonicalType(this.tokens, indexes, this.angles, positions);
			if (part !== "") parts.push(part);
		}
		return parts.join(",");
	}

	/**
	 * Template parameter names by position, so heads naming them apart still match: the own head's
	 * at depth 0, then each enclosing class template's one deeper, innermost first.
	 */
	private templatePositions(
		own: TemplateInfo | null,
		enclosing: ReadonlyArray<readonly string[]>,
	): Map<string, string> {
		const positions = new Map<string, string>();
		const heads = [own?.parameters.map((parameter) => parameter.name) ?? [], ...enclosing];
		for (const [depth, names] of heads.entries())
			for (const [index, name] of names.entries())
				if (!positions.has(name)) positions.set(name, `^${depth}.${index}`);
		return positions;
	}

	/** A conversion operator's type, `const char*` in `operator const char*()`; undefined for any other name. */
	private conversionType(nameStart: number, openIndex: number): TypeRead | undefined {
		if (tokenAt(this.tokens, nameStart)?.text !== "operator") return undefined;
		const first = tokenAt(this.tokens, significantAfter(this.tokens, nameStart, openIndex));
		const named = first?.kind === "identifier" || first?.text === "::";
		if (!named || NON_CONVERSIONS.has(first?.text ?? "")) return undefined;
		return this.typeRead(this.significantIndexes(nameStart + 1, openIndex));
	}

	private typeRead(indexes: number[]): TypeRead | undefined {
		const display = formatType(this.tokens, indexes, this.angles);
		return display === "" ? undefined : { type: { status: "known", display }, indexes };
	}

	/** A parameter list that declares nothing: its types are type uses, its names nobody's. */
	private markParameterTypes(startIndex: number, limit: number): void {
		for (const segment of this.declaratorSegments(startIndex, limit)) {
			const stop = this.topLevelStop(segment.start - 1, segment.end, isAssignment);
			const site = this.declaratorIn(segment.start, stop);
			const name = site !== null && this.specifierShape(segment.start, site.start).typed ? site.name : -1;
			if (name >= 0) this.excludedTokenIndexes.add(name);
			for (const index of this.significantIndexes(segment.start, stop))
				if (index !== name && tokenAt(this.tokens, index)?.kind === "identifier")
					this.typeTokenIndexes.add(index);
		}
	}

	/**
	 * A parameter list's named parameters, as `owner`'s, or with `lambda`, as locals of its scope;
	 * the count of all of them.
	 */
	protected parseParameters(startIndex: number, limit: number, owner: DraftRecord | null, lambda?: Scope): number {
		const parent = owner;
		const templateDependent = lambda?.templateDependent ?? owner?.templateDependent ?? false;
		let count = 0;
		for (const segment of this.declaratorSegments(startIndex, limit)) {
			const tokens = this.significantIndexes(segment.start, segment.end);
			const only = tokens.length === 1 ? tokenAt(this.tokens, tokens[0] as number)?.text : undefined;
			if (tokens.length === 0 || only === "void" || only === "...") continue;
			count++;
			const stop = this.topLevelStop(segment.start - 1, segment.end, isAssignment);
			const site = this.declaratorIn(segment.start, stop);
			// An unnamed parameter's last name is its type's: `const Item&`, `std::string`.
			const named = site !== null && this.specifierShape(segment.start, site.start).typed;
			const typeIndexes =
				site !== null && named
					? [...this.significantIndexes(segment.start, site.start), ...this.declaratorTypeIndexes(site)]
					: this.significantIndexes(segment.start, stop);
			for (const typeIndex of typeIndexes)
				if (tokenAt(this.tokens, typeIndex)?.kind === "identifier") this.typeTokenIndexes.add(typeIndex);
			if (site === null || !named) continue;
			const nameIndex = site.name;
			const name = tokenAt(this.tokens, nameIndex)?.value ?? "parameter";
			const typeText = formatType(this.tokens, typeIndexes, this.angles);
			const start = tokens[0] as number;
			const end = (tokens.at(-1) as number) + 1;
			const dependent = templateDependent && this.dependentType(typeIndexes, this.templateNamesIn(parent));
			const type: DraftType | undefined = dependent
				? unknownTemplateType("template-dependent parameter type is not resolved")
				: typeText === ""
					? undefined
					: isAutoType(typeText)
						? unknownTemplateType("an auto parameter's type is not resolved")
						: { status: "known", display: typeText };
			const parameter = this.addDraft({
				parent,
				own: { kind: lambda === undefined ? "parameter" : "term", name },
				kind: "variable",
				name,
				visibility: "local",
				languageKind: lambda === undefined ? "parameter" : "lambda parameter",
				exported: false,
				startIndex: start,
				endIndex: end,
				nameStartIndex: nameIndex,
				nameEndIndex: nameIndex + 1,
				signature: this.header(start, end, "value"),
				metrics: this.metrics.of(start, end),
				type,
				templateDependent,
				parameterNames: new Set(),
				...this.typeReference(typeIndexes, this.arrayRanks(site.end, stop)),
				...(lambda === undefined ? {} : this.visibleScope(lambda)),
			});
			if (lambda === undefined) parent?.parameterNames.add(name);
			if (lambda === undefined) this.parameterPositions.set(parameter, count - 1);
			parameter.parameterNames.add(name);
		}
		return count;
	}

	/**
	 * A definition's parameters in place of its prototype's, as its name replaces the prototype's:
	 * each prototype parameter's name becomes a use of the definition's in its position.
	 */
	private redeclareParameters(owner: DraftRecord, startIndex: number, limit: number): number {
		let count = 0;
		this.redeclare(owner, "parameter", () => {
			count = this.parseParameters(startIndex, limit, owner);
		});
		return count;
	}

	/**
	 * Declares what `declare` adds to `owner` in place of its earlier children of `kind`, each earlier
	 * one's name a use of the one in its position: a function parameter's in its list, a template
	 * parameter's in its head.
	 */
	private redeclare(
		owner: DraftRecord,
		kind: "parameter" | "typeParameter",
		declare: () => void,
	): Array<[DraftRecord, DraftRecord]> {
		const pairs: Array<[DraftRecord, DraftRecord]> = [];
		const position = (drafts: DraftRecord[]) => {
			const sorted = [...drafts].sort((left, right) => left.nameStartIndex - right.nameStartIndex);
			return new Map(
				sorted.map((draft, rank) => [
					kind === "parameter" ? (this.parameterPositions.get(draft) ?? -1) : rank,
					draft,
				]),
			);
		};
		const earlier = [...(this.declaredIn.get(owner)?.values() ?? [])]
			.flat()
			.filter((draft) => draft.own.kind === kind && draft.mergedInto === undefined);
		const from = this.drafts.length;
		declare();
		const later = position(
			this.drafts.slice(from).filter((draft) => draft.parent === owner && draft.own.kind === kind),
		);
		for (const [at, draft] of position(earlier)) {
			const replacement = later.get(at);
			draft.mergedInto = replacement ?? owner;
			if (replacement === undefined) continue;
			this.roleByToken.set(draft.nameStartIndex, "read");
			this.prototypes.set(draft.nameStartIndex, replacement);
			pairs.push([draft, replacement]);
		}
		return pairs;
	}

	/**
	 * Merges another branch's prototype into the definition that completes it: its name, and each of
	 * its parameters' names, a use of the definition's in its position.
	 */
	private completes(definition: DraftRecord, prototype: DraftRecord): void {
		const parametersOf = (owner: DraftRecord) =>
			[...(this.declaredIn.get(owner)?.values() ?? [])]
				.flat()
				.filter((draft) => draft.own.kind === "parameter" && draft.mergedInto === undefined);
		const byPosition = new Map(
			parametersOf(definition).map((parameter) => [this.parameterPositions.get(parameter) ?? -1, parameter]),
		);
		for (const parameter of parametersOf(prototype)) {
			const replacement = byPosition.get(this.parameterPositions.get(parameter) ?? -1);
			parameter.mergedInto = replacement ?? definition;
			if (replacement === undefined) continue;
			this.roleByToken.set(parameter.nameStartIndex, "read");
			this.prototypes.set(parameter.nameStartIndex, replacement);
		}
		prototype.mergedInto = definition;
		this.roleByToken.set(prototype.nameStartIndex, "read");
		this.prototypes.set(prototype.nameStartIndex, definition);
	}

	private addTemplateReturnInference(record: DraftRecord, bodyIndex: number, bodyClose: number): void {
		if (record.type?.status !== "unknown" && record.type !== undefined) return;
		const types: string[] = [];
		for (let index = bodyIndex; index < bodyClose; index++) {
			if (tokenAt(this.tokens, index)?.text !== "return") continue;
			const end = statementEnd(this.tokens, index, bodyClose);
			const inferred = inferExpressionType(this.tokens, index + 1, end);
			if (inferred === null) {
				record.type = unknownTemplateType("a return expression has no inferred type");
				return;
			}
			types.push(inferred);
		}
		const first = types[0];
		if (first === undefined) {
			record.type = {
				status: "unknown",
				reason: "NotImplemented",
				detail: "no return expression determines auto",
			};
			return;
		}
		if (types.some((type) => type !== first)) {
			record.type = {
				status: "unknown",
				reason: "Ambiguous",
				detail: "return expressions infer different C++ types",
			};
			return;
		}
		record.type = { status: "inferred", display: first, basis: "return expressions" };
	}

	private hasAutoReturn(prefix: Prefix, nameInfo: { nameStartIndex: number }): boolean {
		return this.significantIndexes(prefix.keywordIndex, nameInfo.nameStartIndex).some(
			(index) => tokenAt(this.tokens, index)?.text === "auto",
		);
	}
}
