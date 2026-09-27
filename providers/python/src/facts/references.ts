// Every name a file reads, writes, calls, extends or uses as a type, and its imports.

import type { ImportedName } from "@nyaa-lexicon/protocol";
import type * as A from "../syntax/ast.js";
import { childNodes } from "../syntax/ast.js";
import { parseExpression, parseFunctionType } from "../syntax/parser.js";
import type { Analyzer } from "./analyzer.js";
import {
	comprehensionTargetNames,
	isFunction,
	lambdaParameterNames,
	NodeVisitor,
	typeParamExpressions,
} from "./nodes.js";
import type { Range, RawDescriptor, RawReferenceRole } from "./types.js";

////////////////////////////////
//  Interfaces & Types

interface ReferenceOptions {
	name?: string;
	rangeNode?: A.Node;
	range?: Range;
	bindable?: boolean;
}

////////////////////////////////
//  Functions & Helpers

/** A type comment's expressions: a signature's argument and return types, or one type. */
export function parseTypeComment(text: string | undefined, signature: boolean): A.Expression[] {
	if (text === undefined || text === "") return [];
	if (signature) {
		const parsed = parseFunctionType(text);
		return parsed === undefined ? [] : [...parsed.argtypes, parsed.returns];
	}
	const parsed = parseExpression(text);
	return parsed === undefined ? [] : [parsed];
}

////////////////////////////////
//  Classes

export class ReferenceVisitor extends NodeVisitor {
	private scopePath: RawDescriptor[] = [];
	/** A header is written in its declaration, but resolves in the enclosing scope. */
	private ownerPath: RawDescriptor[] = [];
	private bindingBlocked: string | undefined;
	private blockedLocals: ReadonlySet<string> = new Set();
	/** While a type comment's expressions are visited: where its text starts, or else what it annotates. */
	private comment: { start: number } | { anchor: A.Node } | undefined;

	constructor(private readonly analyzer: Analyzer) {
		super();
	}

	private get source() {
		return this.analyzer.source;
	}

	private addReference(node: A.Node, role: RawReferenceRole, options: ReferenceOptions = {}): void {
		const name = options.name ?? (node.type === "Name" ? node.id : node.type === "Attribute" ? node.attr : "");
		const range = options.range ?? this.rangeOf(options.rangeNode ?? node);
		this.analyzer.references.push({
			name,
			range,
			role,
			qualified: node.type === "Attribute",
			scopePath: [...this.scopePath],
			ownerPath: [...this.ownerPath],
			binding: this.analyzer.scopes.bindingFor({
				name,
				role,
				scopePath: this.scopePath,
				position: range.start,
				bindable: options.bindable ?? true,
				blockedReason: this.bindingBlocked,
				ownerPath: this.ownerPath,
				blockedLocal: this.blockedLocals.has(name),
			}),
		});
	}

	/** A type comment's nodes are placed in its text, parsed apart from the file. */
	private rangeOf(node: A.Node): Range {
		if (this.comment === undefined) return this.source.referenceRange(node);
		if ("anchor" in this.comment) return this.source.referenceRange(this.comment.anchor);
		const start = this.comment.start + (node.type === "Attribute" ? node.end - node.attr.length : node.pos);
		return this.source.range(start, this.comment.start + node.end);
	}

	private addNamedReference(node: A.Node, name: string, role: RawReferenceRole): void {
		this.addReference(node, role, { name, range: this.source.selectionOf(node) });
	}

	override visit(node: A.Node): void {
		switch (node.type) {
			case "ClassDef":
			case "FunctionDef":
			case "AsyncFunctionDef":
				this.visitDefinition(node);
				break;
			case "TypeAlias":
				this.visitTypeAlias(node);
				break;
			case "arg":
				if (node.annotation !== undefined) this.visitTypeExpression(node.annotation);
				this.visitTypeComment(node.typeComment, node);
				break;
			case "Name":
				if (node.id === "__all__") break;
				if (node.ctx === "Load") this.addReference(node, "read");
				else if (node.ctx === "Store") this.addReference(node, "write");
				break;
			case "Attribute":
				this.visit(node.value);
				if (node.ctx === "Load") this.addReference(node, "read", { bindable: false });
				else if (node.ctx === "Store") this.addReference(node, "write", { bindable: false });
				break;
			case "AugAssign":
				this.visitAugmentedTarget(node.target);
				this.visit(node.value);
				break;
			case "AnnAssign":
				this.visit(node.target);
				this.visitTypeExpression(node.annotation);
				if (node.value !== undefined) this.visit(node.value);
				break;
			case "Assign":
			case "For":
			case "AsyncFor":
			case "With":
			case "AsyncWith":
				this.genericVisit(node);
				this.visitTypeComment(node.typeComment, node);
				break;
			case "Lambda":
				// Defaults run where the lambda is written.
				for (const value of [...node.args.defaults, ...node.args.kwDefaults])
					if (value !== undefined) this.visit(value);
				this.blocked("lambda scope is not indexed", lambdaParameterNames(node), () => this.visit(node.body));
				break;
			case "ListComp":
			case "SetComp":
			case "DictComp":
			case "GeneratorExp":
				this.visitComprehension(node);
				break;
			case "ExceptHandler":
				if (node.exceptionType !== undefined) this.visit(node.exceptionType);
				if (node.name !== undefined) this.addNamedReference(node, node.name, "write");
				for (const statement of node.body) this.visit(statement);
				break;
			case "MatchAs":
				if (node.pattern !== undefined) this.visit(node.pattern);
				if (node.name !== undefined) this.addNamedReference(node, node.name, "write");
				break;
			case "MatchStar":
				if (node.name !== undefined) this.addNamedReference(node, node.name, "write");
				break;
			case "MatchMapping":
				for (const key of node.keys) this.visit(key);
				for (const pattern of node.patterns) this.visit(pattern);
				if (node.rest !== undefined) this.addNamedReference(node, node.rest, "write");
				break;
			case "Call":
				this.visitCall(node);
				break;
			case "Import":
				this.visitImport(node);
				break;
			case "ImportFrom":
				this.visitImportFrom(node);
				break;
			default:
				this.genericVisit(node);
		}
	}

	/** Visits a lambda's or comprehension's own scope, whose `names` are its locals. */
	private blocked(reason: string, names: ReadonlySet<string>, visit: () => void): void {
		const oldBlocked = this.bindingBlocked;
		const oldLocals = this.blockedLocals;
		this.bindingBlocked = reason;
		this.blockedLocals = new Set([...oldLocals, ...names]);
		visit();
		this.bindingBlocked = oldBlocked;
		this.blockedLocals = oldLocals;
	}

	/** The first iterable runs where the comprehension is written; the rest in its own scope. */
	private visitComprehension(node: A.Comprehended | A.DictComp): void {
		const [first] = node.generators;
		if (first !== undefined) this.visit(first.iter);
		this.blocked("comprehension scope is not indexed", comprehensionTargetNames(node), () => {
			for (const child of childNodes(node)) {
				if (child !== first) {
					this.visit(child);
					continue;
				}
				this.visit(first.target);
				for (const test of first.ifs) this.visit(test);
			}
		});
	}

	private visitDefinition(node: A.FunctionDef | A.ClassDef): void {
		const oldPath = this.scopePath;
		const oldOwner = this.ownerPath;
		this.ownerPath = this.analyzer.recordedPath(node) ?? oldOwner;
		if (node.type === "ClassDef") this.visitDecoratorsAndBases(node);
		else this.visitFunctionHeader(node);
		this.scopePath = this.analyzer.declarationPath(node, oldPath, node.type === "ClassDef" ? "type" : "method");
		for (const child of node.body) this.visit(child);
		this.scopePath = oldPath;
		this.ownerPath = oldOwner;
	}

	private visitDecoratorsAndBases(node: A.ClassDef): void {
		for (const decorator of node.decoratorList) this.visit(decorator);
		this.visitTypeParams(node);
		for (const base of node.bases) this.visitClassBase(base);
		for (const keyword of node.keywords) this.visit(keyword.value);
	}

	private visitClassBase(node: A.Expression): void {
		if (node.type === "Name") this.addReference(node, "extends");
		else if (node.type === "Attribute") {
			this.visit(node.value);
			this.addReference(node, "extends", { bindable: false });
		} else if (node.type === "Subscript") {
			this.visitClassBase(node.value);
			this.visitTypeExpression(node.slice);
		} else this.visit(node);
	}

	private visitFunctionHeader(node: A.FunctionDef): void {
		for (const decorator of node.decoratorList) this.visit(decorator);
		this.visitTypeParams(node);
		const args = node.args;
		for (const value of [...args.defaults, ...args.kwDefaults]) if (value !== undefined) this.visit(value);
		for (const argument of [...args.posonlyargs, ...args.args, ...args.kwonlyargs]) {
			if (argument.annotation !== undefined) this.visitTypeExpression(argument.annotation);
			this.visitTypeComment(argument.typeComment, argument);
		}
		for (const argument of [args.vararg, args.kwarg]) {
			if (argument === undefined) continue;
			if (argument.annotation !== undefined) this.visitTypeExpression(argument.annotation);
			this.visitTypeComment(argument.typeComment, argument);
		}
		if (node.returns !== undefined) this.visitTypeExpression(node.returns);
		this.visitTypeComment(node.typeComment, node);
	}

	private visitTypeParams(node: A.Node): void {
		for (const expression of typeParamExpressions(node)) this.visitTypeExpression(expression);
	}

	private visitTypeAlias(node: A.TypeAlias): void {
		const oldOwner = this.ownerPath;
		this.ownerPath = this.analyzer.recordedPath(node) ?? oldOwner;
		this.visitTypeParams(node);
		this.visitTypeExpression(node.value);
		this.ownerPath = oldOwner;
	}

	/** A type comment's names, where the comment spells them. */
	private visitTypeComment(text: string | undefined, anchor: A.Node): void {
		const expressions = parseTypeComment(text, isFunction(anchor));
		if (expressions.length === 0) return;
		const start = this.source.typeCommentStart(anchor, text as string);
		const oldComment = this.comment;
		this.comment = start === undefined ? { anchor } : { start };
		for (const expression of expressions) this.visitTypeExpression(expression);
		this.comment = oldComment;
	}

	private visitTypeExpression(node: A.Node): void {
		if (node.type === "Name") this.addReference(node, "typeUse");
		else if (node.type === "Attribute") {
			this.visitTypeExpression(node.value);
			this.addReference(node, "typeUse", { bindable: false });
		}
		// A call's callee and arguments are ordinary, not typeUse.
		else if (node.type === "Call") this.visit(node);
		else for (const child of childNodes(node)) this.visitTypeExpression(child);
	}

	private visitAugmentedTarget(node: A.Expression): void {
		if (node.type === "Name") {
			if (node.id === "__all__") return;
			this.addReference(node, "read");
			this.addReference(node, "write");
		} else if (node.type === "Attribute") {
			this.visit(node.value);
			this.addReference(node, "read", { bindable: false });
			this.addReference(node, "write", { bindable: false });
		} else if (node.type === "Tuple" || node.type === "List") {
			for (const element of node.elts) this.visitAugmentedTarget(element);
		} else if (node.type === "Starred") this.visitAugmentedTarget(node.value);
		else if (node.type === "Subscript") {
			this.visit(node.value);
			this.visit(node.slice);
		} else this.visit(node);
	}

	private visitCall(node: A.Call): void {
		if (node.func.type === "Name") this.addReference(node.func, "call");
		else if (node.func.type === "Attribute") {
			this.visit(node.func.value);
			this.addReference(node.func, "call", { bindable: false });
		} else this.visit(node.func);
		for (const argument of node.args) this.visit(argument);
		for (const keyword of node.keywords) this.visit(keyword.value);
	}

	////////////////////////////////
	//  Imports

	private isConditional(name: string): boolean {
		return this.analyzer.scopes.isConditional(this.scopePath, name);
	}

	private visitImport(node: A.Import): void {
		const aliases = [];
		for (const alias of node.names) {
			const local = alias.asname ?? (alias.name.split(".")[0] as string);
			const localStart = alias.asname === undefined ? alias.pos : alias.end - alias.asname.length;
			const localRange = this.source.range(localStart, localStart + local.length);
			aliases.push({ name: alias.name, localName: local, range: localRange, localRange, star: false });
			// A local import is a re-export only when `__all__` names that local binding.
			this.analyzer.imports.push({
				specifier: alias.name,
				imported: [{ local, localRange }],
				reExport: this.scopePath.length === 0 && this.analyzer.isExplicitlyExported(local),
			});
			this.analyzer.importBindings.push({
				specifier: alias.name,
				localName: local,
				importedName: null,
				scopePath: [...this.scopePath],
				conditional: this.isConditional(local),
				star: false,
			});
		}
		this.analyzer.importStatements.push({
			kind: "import",
			specifier: node.names[0]?.name ?? "",
			range: this.source.rangeOf(node),
			moduleRange: null,
			indent: this.source.statementIndent(node),
			reExport: false,
			aliases,
		});
	}

	private importedName(alias: A.Alias): ImportedName | undefined {
		if (alias.name === "*" || alias.name.includes(".")) return undefined;
		const imported: ImportedName = {
			name: alias.name,
			range: this.source.range(alias.pos, alias.pos + alias.name.length),
		};
		if (alias.asname !== undefined && alias.asname !== alias.name) {
			imported.local = alias.asname;
			imported.localRange = this.source.range(alias.end - alias.asname.length, alias.end);
		}
		return imported;
	}

	private visitImportFrom(node: A.ImportFrom): void {
		const specifier = ".".repeat(node.level) + (node.module ?? "") || ".";
		const imported: ImportedName[] = [];
		const aliases = [];
		for (const alias of node.names) {
			const name = this.importedName(alias);
			if (name !== undefined) imported.push(name);
			aliases.push({
				name: alias.name,
				localName: alias.asname ?? alias.name,
				range: this.source.rangeOf(alias),
				importedRange: name?.range ?? null,
				localRange: name === undefined ? null : (name.localRange ?? name.range ?? null),
				star: alias.name === "*",
			});
		}
		const reExport = this.analyzer.isFromReexport(node.names, this.scopePath);
		this.analyzer.imports.push({ specifier, imported, reExport });
		this.analyzer.importStatements.push({
			kind: "from",
			specifier,
			range: this.source.rangeOf(node),
			moduleRange: this.source.moduleNameRange(node),
			indent: this.source.statementIndent(node),
			reExport,
			aliases,
		});
		for (const alias of node.names) {
			const star = alias.name === "*";
			const local = star ? "*" : (alias.asname ?? alias.name);
			this.analyzer.importBindings.push({
				specifier,
				localName: local,
				importedName: star ? null : alias.name,
				scopePath: [...this.scopePath],
				conditional: this.isConditional(local),
				star,
			});
		}
	}
}
