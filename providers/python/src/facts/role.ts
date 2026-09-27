// Whether loading a file runs a program or only declares one.

import type { FileRole } from "@nyaa-lexicon/protocol";
import type * as A from "../syntax/ast.js";
import { isMainGuard, isStringConstant } from "./nodes.js";

////////////////////////////////
//  Constants

/** Effects on load, weakest first. A file takes its strongest. */
const DECLARES = 0;
const GUARDED = 1;
const RUNS = 2;

const DECLARATIVE: ReadonlySet<A.Node["type"]> = new Set([
	"Import",
	"ImportFrom",
	"FunctionDef",
	"AsyncFunctionDef",
	"ClassDef",
	"Assign",
	"AnnAssign",
	"AugAssign",
	"Pass",
	"TypeAlias",
]);

////////////////////////////////
//  Functions & Helpers

function strongest(statements: readonly A.Statement[]): number {
	return statements.reduce((effect, statement) => Math.max(effect, loadEffect(statement)), DECLARES);
}

function loadEffect(node: A.Statement): number {
	if (DECLARATIVE.has(node.type)) return DECLARES;
	if (node.type === "Expr" && isStringConstant(node.value)) return DECLARES;
	// The guarded body is the program; its else still runs on import.
	if (isMainGuard(node) && node.type === "If") return Math.max(GUARDED, strongest(node.orelse));
	if (node.type === "If") return strongest([...node.body, ...node.orelse]);
	if (node.type === "Try" || node.type === "TryStar") {
		const handlers = node.handlers.flatMap((handler) => handler.body);
		return strongest([...node.body, ...handlers, ...node.orelse, ...node.finalbody]);
	}
	return RUNS;
}

////////////////////////////////
//  Main

export function fileRole(module: A.Module): FileRole {
	const effect = strongest(module.body);
	if (effect === RUNS) return { kind: "entry", how: "topLevel" };
	if (effect === GUARDED) return { kind: "entry", how: "guardedMain" };
	return { kind: "library" };
}
