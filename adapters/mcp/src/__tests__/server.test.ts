import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { LiteralQuery, SessionProject } from "@nyaa-lexicon/core";
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
	"knowledge_gaps",
	"most_referenced",
	"outline_module",
	"overview",
	"recall_answer",
	"refactor_status",
	"resolve_import",
	"search_symbols",
	"symbol_facts",
	"symbol_history",
	"symbol_source",
	"type_of",
] as const;

// Both take no per-query arguments worth batching: overview describes the workspace, and a
// workspace holds one transaction, so asking twice in one call could only ask the same thing.
const BATCH_QUERY_TOOLS = QUERY_TOOLS.filter((name) => name !== "overview" && name !== "refactor_status");

const MUTATION_TOOLS = [
	"invalidate_answer",
	"reaffirm_answer",
	"record_answer",
	"refactor_commit",
	"refactor_move",
	"refactor_rename",
	"refactor_replace",
	"refactor_revert",
	"refactor_start",
	"refactor_track",
	"refactor_undo",
] as const;

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
			indexStatus: async () => ({
				state: "ready",
				done: 1,
				total: 1,
				failures: 0,
				stored: 1,
				fullFiles: 1,
				outlineFiles: 0,
			}),
			searchSymbols: async (text, options) => {
				optionsSeen.push(options);
				return {
					text,
					...(typeof options.regex === "string" ? { regex: options.regex } : {}),
					symbols: [],
					total: 0,
					truncated: false,
				};
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
		// Against the list above rather than a literal, so this stays a duplicate check instead of
		// becoming a second inventory to keep in step with the first.
		expect(new Set(listed.tools.map((tool) => tool.name))).toHaveLength(expected.length);

		for (const name of BATCH_QUERY_TOOLS) {
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

		const overview = listed.tools.find((candidate) => candidate.name === "overview");
		const overviewProperties = overview?.inputSchema.properties as SelectorProperties;
		expect(overviewProperties.queries).toBeUndefined();
		expect(overviewProperties.projects).toMatchObject({
			type: "array",
			items: { type: "string", minLength: 1 },
			uniqueItems: true,
		});

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
	it.each([
		["no filter", {}],
		["two filters", { specifier: "pkg", module: "src/item.ts" }],
		["two regex filters", { specifierRegex: "/pkg/", moduleRegex: "/src/" }],
	])("rejects find_imports with %s", async (_case, query) => {
		const routes: string[] = [];
		const source: BackendSource = (selected) => {
			routes.push(selected.name);
			return backend({ findImports: async () => ({ query: {}, imports: [], total: 0, truncated: false }) });
		};
		const client = await connectClient(source, binding([project("alpha", true)]));

		const result = await call(client, "find_imports", { queries: [query] });

		expect(result.isError).toBe(true);
		expect(routes).toEqual([]);
	});

	it("rejects a malformed import regex", async () => {
		const client = await connectClient(searchSource([], []), binding([project("alpha", true)]));

		const result = await call(client, "find_imports", { queries: [{ specifierRegex: "/(unclosed/" }] });

		expect(result.isError).toBe(true);
	});

	it("forwards an import specifier regex", async () => {
		const seen: unknown[] = [];
		const source: BackendSource = () =>
			backend({
				indexStatus: async () => ({
					state: "ready",
					done: 1,
					total: 1,
					failures: 0,
					stored: 1,
					fullFiles: 1,
					outlineFiles: 0,
				}),
				findImports: async (query) => {
					seen.push(query);
					return { query, imports: [], total: 0, truncated: false };
				},
			});
		const client = await connectClient(source, binding([project("alpha", true)]));

		const result = await call(client, "find_imports", { queries: [{ specifierRegex: "/@scope\\//i" }] });

		expect(result.isError).toBeUndefined();
		expect(seen).toEqual([{ specifierRegex: "/@scope\\//i" }]);
	});

	it("uses projects to select overview indexers", async () => {
		const routes: string[] = [];
		const source: BackendSource = (selected) => {
			routes.push(selected.name);
			return backend({
				overview: async () => ({
					files: 0,
					symbols: 0,
					references: 0,
					imports: 0,
					literals: 0,
					modules: 0,
					scope: "test",
					index: { state: "ready", done: 0, total: 0, failures: 0, stored: 0, fullFiles: 0, outlineFiles: 0 },
					largest: [],
				}),
			});
		};
		const client = await connectClient(source, binding([project("alpha", true), project("beta", true)]));

		const result = await call(client, "overview", { projects: ["beta"] });

		expect(routes).toEqual(["beta"]);
		expect(result.isError).toBeUndefined();
	});

	it("forwards literal regex searches", async () => {
		const seen: LiteralQuery[] = [];
		const source: BackendSource = () =>
			backend({
				indexStatus: async () => ({
					state: "ready",
					done: 1,
					total: 1,
					failures: 0,
					stored: 1,
					fullFiles: 1,
					outlineFiles: 0,
				}),
				findLiterals: async (query) => {
					seen.push(query);
					return { query, literals: [], total: 0, truncated: false };
				},
			});
		const client = await connectClient(source, binding([project("alpha", true)]));

		const result = await call(client, "find_literals", { queries: [{ regex: "/^cycle/i" }] });

		expect(result.isError).toBeUndefined();
		expect(seen).toEqual([{ regex: "/^cycle/i" }]);
	});

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

	it("forwards a valid regex search", async () => {
		const routes: string[] = [];
		const options: Array<Record<string, unknown>> = [];
		const client = await connectClient(searchSource(routes, options), binding([project("alpha", true)]));

		const result = await call(client, "search_symbols", { queries: [{ regex: "/foo\\w*bar/i" }] });

		expect(result.isError).toBeUndefined();
		expect(routes).toEqual(["alpha"]);
		expect(options).toEqual([{ regex: "/foo\\w*bar/i" }]);
	});

	it("rejects an invalid regex before querying", async () => {
		const routes: string[] = [];
		const options: Array<Record<string, unknown>> = [];
		const client = await connectClient(searchSource(routes, options), binding([project("alpha", true)]));

		const result = await call(client, "search_symbols", { queries: [{ regex: "/foo(/" }] });

		expect(result.isError).toBe(true);
		expect(options).toEqual([]);
	});

	it.each([
		["missing", {}],
		["both", { text: "foo", regex: "/foo/" }],
	])("requires exactly one search selector: %s", async (_case, query) => {
		const routes: string[] = [];
		const options: Array<Record<string, unknown>> = [];
		const client = await connectClient(searchSource(routes, options), binding([project("alpha", true)]));

		const result = await call(client, "search_symbols", { queries: [query] });

		expect(result.isError).toBe(true);
		expect(options).toEqual([]);
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
				indexStatus: async () => ({
					state: "ready",
					done: 1,
					total: 1,
					failures: 0,
					stored: 1,
					fullFiles: 1,
					outlineFiles: 0,
				}),
				searchSymbols: async (text) => {
					if (text !== undefined) seen.push(text);
					return { text, symbols: [], total: 0, truncated: false };
				},
			}),
			binding([project("alpha", true)]),
		);

		await call(client, "search_symbols", { queries: [{ text: "Needle" }, { text: "Other" }] });

		expect(seen).toEqual(["Needle", "Other"]);
	});

	// Omission and [] select the same project set.
	it("treats an omitted selector as all bound projects, same as []", async () => {
		const routes: string[] = [];
		const client = await connectClient(
			searchSource(routes, []),
			binding([project("alpha", true), project("beta", true)]),
		);

		const result = await call(client, "search_symbols", { queries: [{ text: "Needle" }] });

		expect(result.isError).toBeUndefined();
		expect(routes).toEqual(["alpha", "beta"]);
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
