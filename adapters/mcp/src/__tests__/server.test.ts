import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SessionProject } from "@nyaa-lexicon/core";
import { afterEach, describe, expect, it } from "vitest";
import type { BindingDeps } from "../binding";
import { buildServer } from "../main";
import type { BackendSource } from "../projectTools";
import type { ToolBackend } from "../tools";

////////////////////////////////
//  Constants

const QUERY_TOOLS = [
	"co_changed_with",
	"describe_symbol",
	"file_history",
	"find_imports",
	"find_literals",
	"find_references",
	"graph_of",
	"hubs",
	"knowledge_gaps",
	"outline_module",
	"overview",
	"prepare_rename",
	"recall_answer",
	"resolve_import",
	"search_symbols",
	"symbol_facts",
	"symbol_history",
	"type_hierarchy",
	"type_of",
] as const;

const MUTATION_TOOLS = ["invalidate_answer", "reaffirm_answer", "record_answer", "rename_symbol"] as const;

const MANAGEMENT_PROPERTIES = {
	bind_project: ["project"],
	delete_project_store: ["key"],
	list_project_stores: [],
	list_projects: [],
	register_project: ["root"],
	stop_project_daemon: ["key"],
	unbind_project: ["project"],
} as const;

const clients: Client[] = [];

type SelectorProperties = {
	project?: Record<string, unknown>;
	projects?: Record<string, unknown>;
	queries?: { items?: Record<string, unknown> };
};

////////////////////////////////
//  Helpers

function project(name: string, bound: boolean): SessionProject {
	return { key: `${name}-key`, root: `/workspaces/${name}`, name, bound };
}

function binding(projects: SessionProject[]): BindingDeps {
	return {
		list: () => projects,
		register: () => ({ registered: false, reason: "not under test" }),
		bind: () => ({ bound: false, reason: "not under test" }),
		unbind: () => ({ bound: false, reason: "not under test" }),
	};
}

function backend(overrides: Partial<ToolBackend>): ToolBackend {
	return new Proxy(overrides, {
		get(target, property, receiver) {
			if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
			return async () => {
				throw new Error(`unexpected backend call: ${String(property)}`);
			};
		},
	}) as ToolBackend;
}

async function connectClient(source: BackendSource, deps: BindingDeps): Promise<Client> {
	const server = buildServer(source, undefined, deps);
	const client = new Client({ name: "lexicon-mcp-test", version: "0.0.0" }, { capabilities: {} });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	await client.connect(clientTransport);
	clients.push(client);
	return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
	return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function searchSource(routes: string[], optionsSeen: Array<Record<string, unknown>>): BackendSource {
	return (selected) => {
		routes.push(selected.name);
		return backend({
			indexStatus: async () => ({ state: "ready", done: 1, total: 1, failures: 0, stored: 1 }),
			searchSymbols: async (text, options) => {
				optionsSeen.push(options);
				return { text, symbols: [], total: 0, truncated: false };
			},
		});
	};
}

afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close()));
});

////////////////////////////////
//  Tests

describe("the published MCP project selectors", () => {
	it("classifies every tool and derives the matching selector schema", async () => {
		const client = await connectClient(backend({}), binding([]));
		const listed = await client.listTools();
		const expected = [...QUERY_TOOLS, ...MUTATION_TOOLS, ...Object.keys(MANAGEMENT_PROPERTIES)].sort();

		expect(listed.tools.map((tool) => tool.name).sort()).toEqual(expected);
		expect(new Set(listed.tools.map((tool) => tool.name))).toHaveLength(30);

		for (const name of QUERY_TOOLS) {
			const tool = listed.tools.find((candidate) => candidate.name === name);
			const properties = tool?.inputSchema.properties as SelectorProperties;
			expect(properties.queries).toMatchObject({ type: "array", minItems: 1 });
			expect(properties.queries?.items).toMatchObject({ type: "object", additionalProperties: false });
			expect(properties.projects).toMatchObject({
				type: "array",
				items: { type: "string", minLength: 1 },
				uniqueItems: true,
			});
			expect(properties.project).toBeUndefined();
			expect(tool?.inputSchema.required ?? []).toContain("queries");
		}

		for (const name of MUTATION_TOOLS) {
			const tool = listed.tools.find((candidate) => candidate.name === name);
			const properties = tool?.inputSchema.properties as SelectorProperties;
			expect(properties.project).toMatchObject({ type: "string", minLength: 1 });
			expect(properties.projects).toBeUndefined();
			expect(tool?.inputSchema.required ?? []).not.toContain("project");
		}

		for (const [name, expectedProperties] of Object.entries(MANAGEMENT_PROPERTIES)) {
			const tool = listed.tools.find((candidate) => candidate.name === name);
			expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual([...expectedProperties].sort());
		}
	});
});

describe("query project routing", () => {
	it("rejects a query when no project is bound", async () => {
		const routes: string[] = [];
		const client = await connectClient(searchSource(routes, []), binding([]));

		const result = await call(client, "search_symbols", { queries: [{ text: "Needle" }] });

		expect(result.isError).toBe(true);
		expect(routes).toEqual([]);
	});

	it("defaults to the sole binding and strips routing metadata", async () => {
		const routes: string[] = [];
		const options: Array<Record<string, unknown>> = [];
		const client = await connectClient(searchSource(routes, options), binding([project("alpha", true)]));

		await call(client, "search_symbols", { queries: [{ text: "Needle" }] });

		expect(routes).toEqual(["alpha"]);
		expect(options).toEqual([{ text: "Needle" }]);
	});

	it("runs several queries in one call", async () => {
		const routes: string[] = [];
		const options: Array<Record<string, unknown>> = [];
		const client = await connectClient(searchSource(routes, options), binding([project("alpha", true)]));

		await call(client, "search_symbols", {
			queries: [{ text: "Needle" }, { text: "Other" }],
		});

		expect(routes).toEqual(["alpha"]);
		expect(options).toEqual([{ text: "Needle" }, { text: "Other" }]);
	});

	it("batches queries through a fixed backend", async () => {
		const seen: string[] = [];
		const client = await connectClient(
			backend({
				indexStatus: async () => ({ state: "ready", done: 1, total: 1, failures: 0, stored: 1 }),
				searchSymbols: async (text) => {
					seen.push(text);
					return { text, symbols: [], total: 0, truncated: false };
				},
			}),
			binding([project("alpha", true)]),
		);

		await call(client, "search_symbols", { queries: [{ text: "Needle" }, { text: "Other" }] });

		expect(seen).toEqual(["Needle", "Other"]);
	});

	it("requires an explicit selector when several projects are bound", async () => {
		const routes: string[] = [];
		const client = await connectClient(
			searchSource(routes, []),
			binding([project("alpha", true), project("beta", true)]),
		);

		const result = await call(client, "search_symbols", { queries: [{ text: "Needle" }] });

		expect(result.isError).toBe(true);
		expect(routes).toEqual([]);
	});

	it("uses an empty array for all bound projects", async () => {
		const routes: string[] = [];
		const client = await connectClient(
			searchSource(routes, []),
			binding([project("alpha", true), project("beta", false), project("gamma", true)]),
		);

		const result = await call(client, "search_symbols", { queries: [{ text: "Needle" }], projects: [] });

		expect(routes).toEqual(["alpha", "gamma"]);
		expect(result.isError).toBeUndefined();
	});

	it("preserves named subset order", async () => {
		const routes: string[] = [];
		const options: Array<Record<string, unknown>> = [];
		const client = await connectClient(
			searchSource(routes, options),
			binding([project("alpha", true), project("beta", true)]),
		);

		const result = await call(client, "search_symbols", {
			queries: [{ text: "Needle" }],
			projects: ["beta", "alpha"],
		});

		expect(routes).toEqual(["beta", "alpha"]);
		expect(options).toEqual([{ text: "Needle" }, { text: "Needle" }]);
		expect(result.isError).toBeUndefined();
	});

	it("returns the direct unlabelled result for one explicitly selected project", async () => {
		const routes: string[] = [];
		const client = await connectClient(
			searchSource(routes, []),
			binding([project("alpha", true), project("beta", true)]),
		);

		const result = await call(client, "search_symbols", { queries: [{ text: "Needle" }], projects: ["beta"] });

		expect(routes).toEqual(["beta"]);
		expect(result.isError).toBeUndefined();
	});

	it("preserves a child error on an all-project result", async () => {
		const routes: string[] = [];
		const source: BackendSource = (selected) => {
			routes.push(selected.name);
			return backend({
				findImports: async (query) => {
					if (selected.name === "alpha") throw new Error("alpha failed");
					return { query, imports: [], total: 0, truncated: false };
				},
			});
		};
		const client = await connectClient(source, binding([project("alpha", true), project("beta", true)]));

		const result = await call(client, "find_imports", { queries: [{ specifier: "pkg" }], projects: [] });

		expect(routes).toEqual(["alpha", "beta"]);
		expect(result.isError).toBe(true);
	});

	it.each([
		["unknown", ["ghost"]],
		["unbound", ["beta"]],
		["durable key", ["alpha-key"]],
		["stale collision name", ["app"]],
		["partly invalid", ["alpha", "ghost"]],
	])("rejects %s selections before any backend call", async (_case, projects) => {
		const routes: string[] = [];
		const client = await connectClient(
			searchSource(routes, []),
			binding([project("alpha", true), project("beta", false), project("app-1", true)]),
		);

		const result = await call(client, "search_symbols", { queries: [{ text: "Needle" }], projects });

		expect(result.isError).toBe(true);
		expect(routes).toEqual([]);
	});

	it("rejects duplicate project names at the schema boundary", async () => {
		const routes: string[] = [];
		const client = await connectClient(searchSource(routes, []), binding([project("alpha", true)]));

		const result = await call(client, "search_symbols", {
			queries: [{ text: "Needle" }],
			projects: ["alpha", "alpha"],
		});

		expect(result.isError).toBe(true);
		expect(routes).toEqual([]);
	});

	it("rejects the scalar mutation selector on a query", async () => {
		const routes: string[] = [];
		const client = await connectClient(searchSource(routes, []), binding([project("alpha", true)]));

		const result = await call(client, "search_symbols", { queries: [{ text: "Needle" }], project: "alpha" });

		expect(result.isError).toBe(true);
		expect(routes).toEqual([]);
	});
});

describe("mutation project routing", () => {
	function recordSource(routes: string[]): BackendSource {
		return (selected) => {
			routes.push(selected.name);
			return backend({ recordAnswer: async () => ({ recorded: false, reason: "observed" }) });
		};
	}

	const args = {
		symbolId: "lexicon test a.ts Thing.",
		question: "describe",
		prose: "Observed.",
		citations: ["lexfact declaration a.ts 0000000000000000"],
	};

	it("routes a scalar selection to one project", async () => {
		const routes: string[] = [];
		const client = await connectClient(
			recordSource(routes),
			binding([project("alpha", true), project("beta", true)]),
		);

		await call(client, "record_answer", { ...args, project: "beta" });

		expect(routes).toEqual(["beta"]);
	});

	it("allows omission with one binding and rejects it with several", async () => {
		const oneRoute: string[] = [];
		const one = await connectClient(recordSource(oneRoute), binding([project("alpha", true)]));
		await call(one, "record_answer", args);
		expect(oneRoute).toEqual(["alpha"]);

		const manyRoutes: string[] = [];
		const many = await connectClient(
			recordSource(manyRoutes),
			binding([project("alpha", true), project("beta", true)]),
		);
		const result = await call(many, "record_answer", args);
		expect(result.isError).toBe(true);
		expect(manyRoutes).toEqual([]);
	});

	it("rejects array syntax for a mutation", async () => {
		const routes: string[] = [];
		const client = await connectClient(recordSource(routes), binding([project("alpha", true)]));

		const result = await call(client, "record_answer", { ...args, project: ["alpha"] });

		expect(result.isError).toBe(true);
		expect(routes).toEqual([]);
	});

	it("rejects the plural query selector on a mutation", async () => {
		const routes: string[] = [];
		const client = await connectClient(recordSource(routes), binding([project("alpha", true)]));

		const result = await call(client, "record_answer", { ...args, projects: ["alpha"] });

		expect(result.isError).toBe(true);
		expect(routes).toEqual([]);
	});

	it.each([
		["unknown", "ghost"],
		["unbound", "beta"],
		["durable key", "alpha-key"],
	])("rejects an %s scalar target before mutation", async (_case, selected) => {
		const routes: string[] = [];
		const client = await connectClient(
			recordSource(routes),
			binding([project("alpha", true), project("beta", false)]),
		);

		const result = await call(client, "record_answer", { ...args, project: selected });

		expect(result.isError).toBe(true);
		expect(routes).toEqual([]);
	});
});
