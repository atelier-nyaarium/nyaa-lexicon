import { describe, expect, it } from "vitest";
import type { RegisteredProject } from "../projectRegistry";
import { createSessionBinds } from "../sessionBinds";

////////////////////////////////
//  Helpers

function project(name: string): RegisteredProject {
	return { key: `${name}-key`, root: `/home/dev/${name}`, name, bound: false };
}

const registry = [project("alpha"), project("beta")];

////////////////////////////////
//  Tests

describe("binding within a session", () => {
	it("starts with nothing bound, so a fresh session asks before it answers", () => {
		expect(createSessionBinds(() => registry).bound()).toEqual([]);
	});

	it("binds and unbinds by name", () => {
		const binds = createSessionBinds(() => registry);

		binds.bind("alpha");
		expect(binds.bound().map((p) => p.name)).toEqual(["alpha"]);

		binds.unbind("alpha");
		expect(binds.bound()).toEqual([]);
	});

	it("binds by key too, since the listing leads with it", () => {
		const binds = createSessionBinds(() => registry);
		expect(binds.bind("alpha-key")).toMatchObject({ bound: true });
	});

	// The whole point of binding many: one question, several codebases.
	it("holds several at once, and unbinding one leaves the rest", () => {
		const binds = createSessionBinds(() => registry);
		binds.bind("alpha");
		binds.bind("beta");
		expect(binds.bound().map((p) => p.name)).toEqual(["alpha", "beta"]);

		binds.unbind("alpha");
		expect(binds.bound().map((p) => p.name)).toEqual(["beta"]);
	});

	it("binding twice is not two bindings", () => {
		const binds = createSessionBinds(() => registry);
		binds.bind("alpha");
		binds.bind("alpha");

		expect(binds.bound()).toHaveLength(1);
	});

	it("flags the whole registry, so a listing shows bound and unbound together", () => {
		const binds = createSessionBinds(() => registry);
		binds.bind("beta");

		expect(binds.all().map((p) => `${p.name}:${p.bound}`)).toEqual(["alpha:false", "beta:true"]);
	});

	it("tells an agent what to do when the name is unknown", () => {
		const outcome = createSessionBinds(() => registry).bind("ghost");

		expect(outcome.bound).toBe(false);
		if (outcome.bound) return;
		expect(outcome.reason).toContain("list_projects");
	});

	// Two sessions, one machine: what one binds must not appear in the other.
	it("keeps one session's bindings out of another's", () => {
		const mine = createSessionBinds(() => registry);
		const theirs = createSessionBinds(() => registry);

		mine.bind("alpha");

		expect(theirs.bound()).toEqual([]);
	});

	it("sees a project registered after the session started", () => {
		let known = [project("alpha")];
		const binds = createSessionBinds(() => known);

		known = [...known, project("gamma")];

		expect(binds.bind("gamma")).toMatchObject({ bound: true });
	});
});
