import type { SessionProject } from "@nyaa-lexicon/core";
import { describe, expect, it } from "vitest";
import { type BindingDeps, bindProjectTool, registerProjectTool, unbindProjectTool } from "../binding";

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

////////////////////////////////
//  Tests

describe("registering", () => {
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
	});

	// A refusal that reads as success is how somebody believes they registered their home directory.
	it("surfaces a refusal as an error", () => {
		const refused = deps([], { register: () => ({ registered: false, reason: "that is your home directory" }) });
		const result = registerProjectTool(refused, { root: "/home/dev" });

		expect(result.isError).toBe(true);
	});
});

describe("binding and unbinding", () => {
	it("binds the requested project", () => {
		let requested: string | undefined;
		const result = bindProjectTool(
			deps([], {
				bind: (name) => {
					requested = name;
					return { bound: true, project: project({ bound: true }) };
				},
			}),
			{ project: "alpha" },
		);

		expect(requested).toBe("alpha");
		expect(result.isError).toBeUndefined();
	});

	it("surfaces an unknown name as an error", () => {
		const missing = deps([], { bind: () => ({ bound: false, reason: "no project called ghost" }) });
		const result = bindProjectTool(missing, { project: "ghost" });

		expect(result.isError).toBe(true);
	});

	it("unbinds the requested project", () => {
		let requested: string | undefined;
		const result = unbindProjectTool(
			deps([], {
				unbind: (name) => {
					requested = name;
					return { bound: true, project: project() };
				},
			}),
			{ project: "alpha" },
		);

		expect(requested).toBe("alpha");
		expect(result.isError).toBeUndefined();
	});
});
