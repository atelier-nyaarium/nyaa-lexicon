import type { SessionProject } from "@nyaa-lexicon/core";
import { describe, expect, it } from "vitest";
import {
	type BindingDeps,
	bindProjectTool,
	listProjectsTool,
	nothingBoundMessage,
	registerProjectTool,
	unbindProjectTool,
} from "../binding";

////////////////////////////////
//  Helpers

function project(overrides: Partial<SessionProject> = {}): SessionProject {
	return { key: "alpha-abc123", root: "/home/dev/alpha", name: "alpha", bound: false, ...overrides };
}

function deps(projects: SessionProject[], overrides: Partial<BindingDeps> = {}): BindingDeps {
	return {
		list: () => projects,
		register: () => ({
			registered: true,
			project: project(),
			already: false,
			sync: { renames: [], bindingsCleared: false },
		}),
		bind: () => ({ bound: true, project: project({ bound: true }) }),
		unbind: () => ({ bound: true, project: project() }),
		...overrides,
	};
}

function textOf(result: { content: Array<{ text: string }> }): string {
	return result.content.map((chunk) => chunk.text).join("\n");
}

////////////////////////////////
//  Tests

describe("listing projects", () => {
	it("names the next call when nothing is registered", () => {
		expect(textOf(listProjectsTool(deps([])))).toContain("register_project");
	});

	it("marks bound rows", () => {
		const shown = textOf(listProjectsTool(deps([project({ bound: true }), project({ name: "beta" })])));
		const [, boundRow, unboundRow] = shown.split("\n");

		expect(shown).toContain("alpha");
		expect(shown).toContain("/home/dev/alpha");
		expect(boundRow?.trimStart().startsWith("●")).toBe(true);
		expect(unboundRow?.trimStart().startsWith("●")).toBe(false);
		expect(shown.split("\n")).toHaveLength(3);
	});

	it("sorts projects by their newest index time", () => {
		const shown = textOf(
			listProjectsTool({
				...deps([project({ bound: true }), project({ name: "beta", key: "beta-key" })]),
				indexTimes: () =>
					new Map([
						["alpha-abc123", 100],
						["beta-key", 200],
					]),
			}),
		);

		expect(shown.indexOf("beta")).toBeLessThan(shown.indexOf("alpha"));
	});
});

describe("registering", () => {
	it("points at binding, since registering alone answers nothing", () => {
		expect(textOf(registerProjectTool(deps([]), { root: "/home/dev/alpha" }))).toContain("bind_project");
	});

	it("reports an already-known project without treating it as an error", () => {
		const already = deps([], {
			register: () => ({
				registered: true,
				project: project(),
				already: true,
				sync: { renames: [], bindingsCleared: false },
			}),
		});
		const result = registerProjectTool(already, { root: "/home/dev/alpha" });

		expect(result.isError).toBeUndefined();
		expect(textOf(result)).toContain("already registered");
	});

	it("reports collision renames and cleared bindings", () => {
		const collision = deps([], {
			register: () => ({
				registered: true,
				project: project({ name: "app-2", root: "/work/two/app" }),
				already: false,
				sync: {
					renames: [{ key: "app-key", root: "/work/one/app", from: "app", to: "app-1" }],
					bindingsCleared: true,
				},
			}),
		});

		const shown = textOf(registerProjectTool(collision, { root: "/work/two/app" }));

		expect(shown).toContain("app is now app-1");
		expect(shown).toContain("All session bindings were cleared");
		expect(shown).toContain("list_projects");
	});

	// A refusal that reads as success is how somebody believes they registered their home directory.
	it("surfaces a refusal as an error", () => {
		const refused = deps([], { register: () => ({ registered: false, reason: "that is your home directory" }) });
		const result = registerProjectTool(refused, { root: "/home/dev" });

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("home directory");
	});
});

describe("binding and unbinding", () => {
	it("confirms a bind and says the index is shared", () => {
		expect(textOf(bindProjectTool(deps([]), { project: "alpha" }))).toContain("other sessions");
	});

	it("surfaces an unknown name as an error", () => {
		const missing = deps([], { bind: () => ({ bound: false, reason: "no project called ghost" }) });
		const result = bindProjectTool(missing, { project: "ghost" });

		expect(result.isError).toBe(true);
	});

	it("says the index survives an unbind, so nobody unbinds expecting a delete", () => {
		expect(textOf(unbindProjectTool(deps([]), { project: "alpha" }))).toContain("untouched");
	});
});

describe("what a query says when it cannot answer", () => {
	it("gives the same recovery path regardless of the registered projects", () => {
		const expected = "No project is bound. Call list_projects for the list of projects. Bind with bind_project.";

		expect(nothingBoundMessage([])).toBe(expected);
		expect(nothingBoundMessage([project(), project({ name: "beta" })])).toBe(expected);
	});
});
