import { composeSymbolId, type Declaration, defined, type OffsetRange } from "@nyaa-lexicon/protocol";
import type { Generics, RawDeclaration, RustDescriptor, TypeAnswer } from "./model.js";
import { Prefixes } from "./prefixes.js";
import type { RustToken } from "./tokens.js";

////////////////////////////////
//  Constants

const LANGUAGE = "rust";

const TYPE_KINDS = new Set(["struct", "enum", "interface", "class"]);

////////////////////////////////
//  Interfaces & Types

export interface ParseContext {
	descriptors: RustDescriptor[];
	containerId?: string;
	kind: "root" | "module" | "type" | "trait" | "impl" | "function";
	implTrait?: string;
}

export interface DeclarationInput {
	nameIndex: number;
	/** A name the source does not spell, as an impl's; its name token is then the selection. */
	label?: string;
	start: RustToken;
	end: RustToken;
	context: ParseContext;
	descriptor: RustDescriptor;
	/** An impl's type path, which its items hang from. */
	memberPath?: RustDescriptor[] | undefined;
	kind: Declaration["kind"];
	languageKind: string;
	visibility: Declaration["visibility"];
	exported: boolean;
	signature?: string | undefined;
	typeName?: string | undefined;
	typeDisplay?: string | undefined;
	typeSpan?: { start: number; end: number } | undefined;
	metrics?: Declaration["metrics"];
	valueType?: readonly string[] | undefined;
	initializer?: number | undefined;
	generics?: Generics | undefined;
	fileModule?: { path?: string } | undefined;
	/** A local: an ordinal id rather than a descriptor path. */
	local?: boolean;
	scope?: OffsetRange;
	memberInsertLine?: number | undefined;
}

////////////////////////////////
//  Functions & Helpers

export function descriptorKey(descriptors: readonly RustDescriptor[]): string {
	return descriptors
		.map(
			(descriptor) =>
				`${descriptor.kind}:${descriptor.name}:${descriptor.disambiguator ?? ""}:${descriptor.occurrence ?? ""}`,
		)
		.join("/");
}

export function sanitizeDisambiguator(value: string): string {
	const cleaned = [...value].filter((character) => /[A-Za-z0-9._-]/u.test(character)).join("");
	return cleaned === "" ? "impl" : cleaned;
}

////////////////////////////////
//  Classes

/** Each declaration's id and record, and its declared type. */
export abstract class Declarations extends Prefixes {
	protected readonly rawDeclarations: RawDeclaration[] = [];
	protected readonly typeAnswers = new Map<string, TypeAnswer>();
	protected readonly declarationNameTokens = new Set<number>();
	private readonly methodCounts = new Map<string, number>();
	/** Declarations per descriptor path, so a repeat takes an occurrence. */
	private readonly pathCounts = new Map<string, number>();
	/** The first type at each descriptor path. */
	protected readonly typesByPath = new Map<string, RawDeclaration>();
	private localOrdinal = 0;

	protected addRawDeclaration(input: DeclarationInput): RawDeclaration {
		const nameToken = this.tokens[input.nameIndex] as RustToken;
		const descriptorPath = input.local
			? [...input.context.descriptors, input.descriptor]
			: this.occurrencePath([...input.context.descriptors, input.descriptor]);
		const symbolId = input.local
			? composeSymbolId({ language: LANGUAGE, module: this.module, descriptors: [], local: this.localOrdinal++ })
			: composeSymbolId({ language: LANGUAGE, module: this.module, descriptors: descriptorPath });
		const declaration: Declaration = {
			symbolId,
			kind: input.kind,
			languageKind: input.languageKind,
			name: input.label ?? nameToken.value,
			range: { start: input.start.start, end: input.end.end },
			selectionRange: { start: nameToken.start, end: nameToken.end },
			visibility: input.visibility,
			exported: input.exported,
			...defined({
				containerId: input.context.containerId,
				signature: input.signature,
				memberInsertLine: input.memberInsertLine,
			}),
			metrics: input.metrics ?? { lines: input.end.end.line - input.start.start.line + 1 },
		};
		const raw: RawDeclaration = {
			declaration,
			startOffset: input.start.startOffset,
			endOffset: input.end.endOffset,
			nameToken,
			descriptorPath,
			containerPath: input.context.descriptors,
			...defined({
				typeName: input.typeName,
				typeDisplay: input.typeDisplay,
				typeSpan: input.typeSpan,
				localOrdinal: input.local ? this.localOrdinal - 1 : undefined,
				scope: input.scope,
				memberPath: input.memberPath,
				valueType: input.valueType,
				initializer: input.initializer,
				generics: input.generics,
				fileModule: input.fileModule,
			}),
		};
		this.rawDeclarations.push(raw);
		const key = descriptorKey(descriptorPath);
		if (!input.local && TYPE_KINDS.has(input.kind) && !this.typesByPath.has(key)) this.typesByPath.set(key, raw);
		this.declarationNameTokens.add(input.nameIndex);
		if (this.depth !== "outline" && input.typeDisplay !== undefined) {
			this.typeAnswers.set(symbolId, {
				status: "known",
				display: input.typeDisplay,
				...defined({ typeName: input.typeName }),
			});
		}
		return raw;
	}

	/** A repeated path's last descriptor takes its occurrence, from the second on. */
	private occurrencePath(path: RustDescriptor[]): RustDescriptor[] {
		const key = descriptorKey(path);
		const count = (this.pathCounts.get(key) ?? 0) + 1;
		this.pathCounts.set(key, count);
		const last = path.at(-1);
		return count === 1 || last === undefined ? path : [...path.slice(0, -1), { ...last, occurrence: count }];
	}

	/** A context whose declarations sit in `raw`, and whose members hang from `path`. */
	protected within(raw: RawDeclaration, kind: ParseContext["kind"], path = raw.descriptorPath): ParseContext {
		return { descriptors: path, containerId: raw.declaration.symbolId, kind };
	}

	protected methodDescriptor(context: ParseContext, name: string): RustDescriptor {
		const key = `${descriptorKey(context.descriptors)}:${name}`;
		const count = this.methodCounts.get(key) ?? 0;
		this.methodCounts.set(key, count + 1);
		if (count === 0) return { kind: "method", name };
		const trait = context.implTrait === undefined ? "overload" : sanitizeDisambiguator(context.implTrait);
		return { kind: "method", name, disambiguator: `${trait}-${count}` };
	}
}
