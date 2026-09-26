import {
	composeSymbolId,
	type Declaration,
	type Descriptor,
	defined,
	type Metrics,
	type TypeInfo,
} from "@nyaa-lexicon/protocol";
import { type DeclaredNodes, type HeaderFacts, LANGUAGE, type TypeFact, type TypePath } from "./facts.js";
import { literalShape } from "./literals.js";
import { renderType } from "./render.js";
import type { LineTable, SyntaxNode } from "./tree.js";
import { TYPE_NODES, typePath } from "./typePaths.js";

/** What a declaration's id is minted from. */
export interface IdScope {
	descriptors: Descriptor[];
	containerId?: string;
}

export interface Minted {
	symbolId: string;
	descriptors: Descriptor[];
	declaration: Declaration;
}

export interface MintInput {
	node: SyntaxNode;
	start?: number;
	end?: number;
	nameNode: SyntaxNode;
	name: string;
	kind: Declaration["kind"];
	languageKind?: string;
	descriptorKind: Descriptor["kind"];
	scope: IdScope;
	access: Pick<Declaration, "visibility" | "exported">;
	signature?: string | undefined;
	owns: boolean;
	metrics?: Omit<Metrics, "lines">;
}

export interface SinkFacts extends HeaderFacts {
	declarations: Declaration[];
	nodes: DeclaredNodes;
	typeFacts: TypeFact[];
}

/** The one minter of Kotlin symbol ids. */
export class DeclarationSink {
	private readonly declarations: Declaration[] = [];
	private readonly typeFacts: TypeFact[] = [];
	private readonly nameCounts = new Map<string, number>();
	private readonly supertypeMap = new Map<string, TypePath[]>();
	private readonly receiverMap = new Map<string, TypePath>();
	/** Properties, keyed by id. */
	private readonly valueHolders = new Map<string, Declaration>();
	private readonly nodeDeclarations = new Map<SyntaxNode, Declaration>();
	private readonly ownerNodes = new Set<SyntaxNode>();
	private readonly nameNodes = new Set<SyntaxNode>();

	constructor(
		private readonly module: string,
		private readonly text: string,
		private readonly lines: LineTable,
		private readonly outline: boolean,
	) {}

	facts(): SinkFacts {
		return {
			declarations: this.declarations,
			nodes: { declarations: this.nodeDeclarations, owners: this.ownerNodes, names: this.nameNodes },
			typeFacts: this.typeFacts,
			supertypes: this.supertypeMap,
			receiverTypes: this.receiverMap,
		};
	}

	push(declaration: Declaration): void {
		this.declarations.push(declaration);
	}

	add(input: MintInput): Minted {
		const method = input.descriptorKind === "method";
		const descriptor = this.descriptor(input.descriptorKind, input.name, input.scope.descriptors, method);
		const descriptors = [...input.scope.descriptors, descriptor];
		const symbolId = composeSymbolId({ language: LANGUAGE, module: this.module, descriptors });
		const range = this.lines.range(input.start ?? input.node.start, input.end ?? input.node.end);
		const declaration: Declaration = {
			symbolId,
			kind: input.kind,
			...defined({ languageKind: input.languageKind }),
			name: input.name,
			range,
			selectionRange: this.range(input.nameNode),
			...input.access,
			...defined({ signature: input.signature, containerId: input.scope.containerId }),
			metrics: { lines: range.end.line - range.start.line + 1, ...input.metrics },
		};
		this.declarations.push(declaration);
		// Type params: signature only.
		const holder =
			input.scope.containerId === undefined ? undefined : this.valueHolders.get(input.scope.containerId);
		if (holder !== undefined && input.descriptorKind !== "typeParameter") holder.contains = "locals";
		this.nodeDeclarations.set(input.node, declaration);
		if (input.owns) this.ownerNodes.add(input.node);
		if (input.nameNode.type === "identifier") this.nameNodes.add(input.nameNode);
		return { symbolId, descriptors, declaration };
	}

	holdsValues(declaration: Declaration): void {
		this.valueHolders.set(declaration.symbolId, declaration);
	}

	supertypes(symbolId: string, paths: TypePath[]): void {
		if (paths.length > 0) this.supertypeMap.set(symbolId, paths);
	}

	receiverType(symbolId: string, before: SyntaxNode[]): void {
		const path = typePath(
			this.text,
			before.findLast((child) => TYPE_NODES.has(child.type)),
		);
		if (path !== undefined) this.receiverMap.set(symbolId, path);
	}

	declaredType(symbolId: string, type: SyntaxNode | undefined): void {
		if (this.outline || type === undefined) return;
		const display = renderType(this.text, [type], this.lines);
		if (display === "") return;
		this.typeFacts.push({
			symbolId,
			answer: { status: "known", display, provenance: "declared" },
			annotationRange: this.range(type),
		});
	}

	inferredType(symbolId: string, initializer: SyntaxNode | undefined): void {
		if (this.outline || initializer === undefined) return;
		const shape = literalShape(this.text, initializer);
		if (shape === null) return;
		const answer: TypeInfo = { status: "inferred", display: shape.display, basis: "literal initializer" };
		this.typeFacts.push({ symbolId, answer });
	}

	private range(node: SyntaxNode) {
		return this.lines.range(node.start, node.end);
	}

	private descriptor(kind: Descriptor["kind"], name: string, parent: Descriptor[], method: boolean): Descriptor {
		const key = `${parent.map((item) => `${item.kind}:${item.name}`).join("/")}|${kind}:${name}`;
		const count = this.nameCounts.get(key) ?? 0;
		this.nameCounts.set(key, count + 1);
		if (count === 0 || !method) return { kind, name: count === 0 ? name : `${name}@${count}` };
		return { kind: "method", name, disambiguator: String(count) };
	}
}
