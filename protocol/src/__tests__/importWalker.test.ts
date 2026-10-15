import { describe, expect, it } from "bun:test";
import { type ImportGraphCallbacks, walkImportGraph, walkImportGraphEntries } from "../providerKit.js";

interface Node {
	module: string;
	context: string;
	imports: string[];
}

describe("walkImportGraph", () => {
	it("folds in source order and stops a cycle by module", () => {
		const rootImports = ["left", "right"];
		const nodes: Record<string, string[]> = {
			root: rootImports,
			left: ["root", "leaf"],
			leaf: [],
			right: [],
		};
		const events: string[] = [];
		const callbacks: ImportGraphCallbacks<Node, string, string, string> = {
			module: (state) => state.module,
			key: (state) => state.module,
			imports: (state) => state.imports,
			resolve: (state, edge) => {
				events.push(`resolve:${state.module}:${edge}`);
				const imports = nodes[edge];
				return imports === undefined ? undefined : { module: edge, context: state.context, imports };
			},
			initial: (state) => {
				events.push(`initial:${state.module}`);
				return state.module;
			},
			apply: (state, edge, current, child) => {
				events.push(`apply:${state.module}:${edge}`);
				return `${current}/${edge}:${child ?? "skipped"}`;
			},
		};

		const result = walkImportGraph({ module: "root", context: "one", imports: rootImports }, callbacks, new Map());

		expect(result).toBe("root/left:left/root:skipped/leaf:leaf/right:right");
		expect(events).toEqual([
			"initial:root",
			"resolve:root:left",
			"initial:left",
			"resolve:left:root",
			"apply:left:root",
			"resolve:left:leaf",
			"initial:leaf",
			"apply:left:leaf",
			"apply:root:left",
			"resolve:root:right",
			"initial:right",
			"apply:root:right",
		]);
	});

	it("memoizes by provider key, including context beyond the module", () => {
		const initial: string[] = [];
		const callbacks: ImportGraphCallbacks<Node, string, string, string> = {
			module: (state) => state.module,
			key: (state) => `${state.module}:${state.context}`,
			imports: (state) => state.imports,
			resolve: (state, edge) => ({ module: "shared", context: edge, imports: [] }),
			initial: (state) => {
				initial.push(`${state.module}:${state.context}`);
				return `${state.module}:${state.context}`;
			},
			apply: (_state, _edge, current, child) => `${current}/${child ?? "skipped"}`,
		};
		const root: Node = { module: "root", context: "root", imports: ["same", "same", "other"] };

		expect(walkImportGraph(root, callbacks, new Map())).toBe("root:root/shared:same/shared:same/shared:other");
		expect(initial).toEqual(["root:root", "shared:same", "shared:other"]);
	});

	it("lists reachable modules in breadth-first or depth-first source order", () => {
		const rootImports = ["left", "right"];
		const nodes: Record<string, string[]> = {
			root: rootImports,
			left: ["leaf", "root"],
			right: ["last"],
			leaf: [],
			last: [],
		};
		const root: Node = { module: "root", context: "one", imports: rootImports };
		const callbacks = {
			module: (state: Node) => state.module,
			key: (state: Node) => state.module,
			imports: (state: Node) => state.imports,
			resolve: (state: Node, edge: string): Node | undefined => {
				const imports = nodes[edge];
				return imports === undefined ? undefined : { module: edge, context: state.context, imports };
			},
		};
		const names = (order: "depthFirst" | "breadthFirst") =>
			walkImportGraphEntries(root, callbacks, new Map<string, Node>(), order).map(({ state }) => state.module);

		expect(names("breadthFirst")).toEqual(["left", "right", "leaf", "last"]);
		expect(names("depthFirst")).toEqual(["left", "leaf", "right", "last"]);
	});
});
