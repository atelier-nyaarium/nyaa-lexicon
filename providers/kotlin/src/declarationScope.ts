import type { DeclarationSink, IdScope } from "./declarationSink.js";
import type { LineTable, SyntaxTree } from "./tree.js";

export interface Scope extends IdScope {
	classId?: string;
	className?: string;
	/** Inside a primary constructor: where its properties land. */
	classScope?: Scope;
}

/** What every handler reads. */
export interface DeclarationWalk {
	readonly sink: DeclarationSink;
	readonly text: string;
	readonly tree: SyntaxTree;
	readonly lines: LineTable;
}
