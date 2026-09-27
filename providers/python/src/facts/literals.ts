// String, number and boolean values written in a file, docstrings aside.

import type * as A from "../syntax/ast.js";
import { walk } from "../syntax/ast.js";
import type { Analyzer } from "./analyzer.js";
import { docstringOf, NodeVisitor, typeParamExpressions } from "./nodes.js";
import type { RawDescriptor, RawLiteral } from "./types.js";

////////////////////////////////
//  Functions & Helpers

function docstrings(tree: A.Module): Set<A.Constant> {
	const found = new Set<A.Constant>();
	for (const node of walk(tree)) {
		if (
			node.type !== "Module" &&
			node.type !== "ClassDef" &&
			node.type !== "FunctionDef" &&
			node.type !== "AsyncFunctionDef"
		) {
			continue;
		}
		const docstring = docstringOf(node.body);
		if (docstring !== undefined) found.add(docstring);
	}
	return found;
}

/** A number the protocol can carry; undefined past a double's range. */
function finite(value: number): number | undefined {
	return Number.isFinite(value) ? value : undefined;
}

////////////////////////////////
//  Classes

export class LiteralVisitor extends NodeVisitor {
	private scopePath: RawDescriptor[] = [];
	private readonly literals: RawLiteral[] = [];
	private readonly docstrings: Set<A.Constant>;

	constructor(private readonly analyzer: Analyzer) {
		super();
		this.docstrings = docstrings(analyzer.tree);
	}

	private add(kind: RawLiteral["kind"], value: string, node: A.Node, number?: number): void {
		this.literals.push({
			kind,
			value,
			range: this.analyzer.source.rangeOf(node),
			...(number === undefined ? {} : { number }),
			...(this.scopePath.length === 0 ? {} : { containerPath: [...this.scopePath] }),
		});
	}

	override visit(node: A.Node): void {
		switch (node.type) {
			case "ClassDef":
				this.visitDeclaration(node, this.analyzer.declarationPath(node, this.scopePath, "type"));
				break;
			case "FunctionDef":
			case "AsyncFunctionDef":
				this.visitDeclaration(node, this.analyzer.declarationPath(node, this.scopePath, "method"));
				break;
			case "JoinedStr":
				this.visitJoinedStr(node);
				break;
			case "UnaryOp":
				this.visitUnaryOp(node);
				break;
			case "Constant":
				this.visitConstant(node);
				break;
			default:
				this.genericVisit(node);
		}
	}

	private visitDeclaration(node: A.FunctionDef | A.ClassDef, path: RawDescriptor[]): void {
		const oldPath = this.scopePath;
		this.scopePath = path;
		for (const decorator of node.decoratorList) this.visit(decorator);
		for (const expression of typeParamExpressions(node)) this.visit(expression);
		if (node.type === "ClassDef") {
			for (const base of node.bases) this.visit(base);
			for (const keyword of node.keywords) this.visit(keyword.value);
		} else {
			this.visit(node.args);
			if (node.returns !== undefined) this.visit(node.returns);
		}
		for (const statement of node.body) this.visit(statement);
		this.scopePath = oldPath;
	}

	private visitJoinedStr(node: A.JoinedStr): void {
		const texts = node.values.filter((value) => value.type === "Constant" && value.value.kind === "str");
		if (texts.length === node.values.length) {
			const joined = texts
				.map((value) => (value.type === "Constant" && value.value.kind === "str" ? value.value.value : ""))
				.join("");
			this.add("string", joined, node);
			return;
		}
		// Each text run is its own literal: one range for the node would cover the substitutions.
		for (const value of node.values) {
			if (value.type === "Constant") {
				// An empty run, a format spec opening straight on `{`, has no span to report.
				if (value.value.kind === "str" && value.value.value !== "")
					this.add("string", value.value.value, value);
			} else if (value.type === "FormattedValue") {
				this.visit(value.value);
				if (value.formatSpec !== undefined) this.visit(value.formatSpec);
			}
		}
	}

	private visitUnaryOp(node: A.UnaryOp): void {
		const operand = node.operand;
		if (
			(node.op === "UAdd" || node.op === "USub") &&
			operand.type === "Constant" &&
			(operand.value.kind === "int" || operand.value.kind === "float")
		) {
			const magnitude = Number(operand.value.value);
			const signed = node.op === "UAdd" ? magnitude : -magnitude;
			const number = operand.value.kind === "int" && signed === 0 ? 0 : signed;
			this.add("number", this.analyzer.source.segment(node), node, finite(number));
			return;
		}
		this.genericVisit(node);
	}

	private visitConstant(node: A.Constant): void {
		if (this.docstrings.has(node)) return;
		const value = node.value;
		if (value.kind === "str") this.add("string", value.value, node);
		// Canonical, so one search finds a boolean whatever language wrote it.
		else if (value.kind === "bool") this.add("boolean", value.value ? "true" : "false", node);
		else if (value.kind === "int" || value.kind === "float") {
			this.add("number", this.analyzer.source.segment(node), node, finite(Number(value.value)));
		}
	}

	run(): RawLiteral[] {
		this.visit(this.analyzer.tree);
		return this.literals;
	}
}
