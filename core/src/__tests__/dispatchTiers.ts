/** Methods `dispatch.ts` answers through `treeFirst`: a tree upgrade alone, then the answer shared. */
export const TREE_FIRST = [
	"describe",
	"typeHierarchy",
	"callHierarchy",
	"findReferences",
	"usesFrom",
	"factsFor",
	"typeOf",
] as const;
