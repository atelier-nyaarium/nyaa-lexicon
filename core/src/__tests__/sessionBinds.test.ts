import { describe, expect, it } from "bun:test";
import type { RegisteredProject } from "../projectRegistry";
import { createSessionBinds } from "../sessionBinds";

////////////////////////////////
//  Helpers

function project(name: string, parent = "/home/dev"): RegisteredProject {
	return { key: `${parent}/${name}-key`, root: `${parent}/${name}` };
}

/** The same workspace, in a directory of its own choosing. */
function custom(name: string, stateDir: string, parent = "/home/dev"): RegisteredProject {
	return { ...project(name, parent), stateDir };
}

const registry = [project("alpha"), project("beta")];

////////////////////////////////
//  Tests

describe("binding within a session", () => {
	it("starts with nothing bound, so a fresh session asks before it answers", () => {
		expect(createSessionBinds(() => registry).bound()).toEqual([]);
	});

	it("binds and unbinds by session name", () => {
		const binds = createSessionBinds(() => registry);

		binds.bind("alpha");
		expect(binds.bound().map((entry) => entry.name)).toEqual(["alpha"]);

		binds.unbind("alpha");
		expect(binds.bound()).toEqual([]);
	});

	it("does not expose the durable key as a binding selector", () => {
		const binds = createSessionBinds(() => registry);

		expect(binds.bind(registry[0]?.key ?? "")).toMatchObject({ bound: false });
		expect(binds.bound()).toEqual([]);
	});

	it("holds several bindings and removes only the selected one", () => {
		const binds = createSessionBinds(() => registry);
		binds.bind("alpha");
		binds.bind("beta");
		expect(binds.bound().map((entry) => entry.name)).toEqual(["alpha", "beta"]);

		binds.unbind("alpha");
		expect(binds.bound().map((entry) => entry.name)).toEqual(["beta"]);
	});

	it("binding twice is one binding", () => {
		const binds = createSessionBinds(() => registry);
		binds.bind("alpha");
		binds.bind("alpha");

		expect(binds.bound()).toHaveLength(1);
	});

	it("lists the whole catalog with session bound state", () => {
		const binds = createSessionBinds(() => registry);
		binds.bind("beta");

		expect(binds.all().map((entry) => `${entry.name}:${entry.bound}`)).toEqual(["alpha:false", "beta:true"]);
	});

	it("tells an agent how to recover from an unknown name", () => {
		const outcome = createSessionBinds(() => registry).bind("ghost");

		expect(outcome.bound).toBe(false);
		if (outcome.bound) return;
		expect(outcome.reason).toContain("list_projects");
	});

	it("keeps one session's bindings out of another's", () => {
		const mine = createSessionBinds(() => registry);
		const theirs = createSessionBinds(() => registry);

		mine.bind("alpha");

		expect(theirs.bound()).toEqual([]);
	});

	it("sees a uniquely named project registered after the session started", () => {
		let known = [project("alpha")];
		const binds = createSessionBinds(() => known);

		known = [...known, project("gamma")];

		expect(binds.bind("gamma")).toMatchObject({ bound: true });
	});
});

describe("session project names", () => {
	it("numbers every member of a fresh basename collision in registry order", () => {
		const projects = [project("app", "/work/one"), project("app", "/work/two")];

		expect(
			createSessionBinds(() => projects)
				.all()
				.map((entry) => entry.name),
		).toEqual(["app-1", "app-2"]);
	});

	it("keeps every generated name globally unique", () => {
		const projects = [project("app", "/work/one"), project("app-1", "/work/other"), project("app", "/work/two")];

		expect(
			createSessionBinds(() => projects)
				.all()
				.map((entry) => entry.name),
		).toEqual(["app-1", "app-1-2", "app-2"]);
	});

	it("renames a bare name as soon as a live collision appears", () => {
		let known = [project("app", "/work/one")];
		const binds = createSessionBinds(() => known);
		const first = known[0];

		known = [...known, project("app", "/work/two")];
		if (first === undefined) throw new Error("initial project missing");

		expect(binds.sync()).toEqual({
			renames: [{ key: first?.key, root: first?.root, from: "app", to: "app-1" }],
			bindingsCleared: false,
		});
		expect(binds.all().map((entry) => entry.name)).toEqual(["app-1", "app-2"]);
		expect(binds.bind("app")).toMatchObject({ bound: false });
	});

	it("clears every binding when a live rename touches a bound project", () => {
		let known = [project("app", "/work/one"), project("other")];
		const binds = createSessionBinds(() => known);
		binds.bind("app");
		binds.bind("other");

		known = [...known, project("app", "/work/two")];

		expect(binds.sync().bindingsCleared).toBe(true);
		expect(binds.bound()).toEqual([]);
	});

	it("reconciles and clears bindings through ordinary catalog access", () => {
		let known = [project("app", "/work/one"), project("other")];
		const binds = createSessionBinds(() => known);
		binds.bind("app");
		binds.bind("other");

		known = [...known, project("app", "/work/two")];

		expect(binds.bound()).toEqual([]);
		expect(binds.all().map((entry) => entry.name)).toEqual(["app-1", "other", "app-2"]);
	});

	it("preserves bindings when a live rename touches only an unbound project", () => {
		let known = [project("app", "/work/one"), project("other")];
		const binds = createSessionBinds(() => known);
		binds.bind("other");

		known = [...known, project("app", "/work/two")];

		expect(binds.sync().bindingsCleared).toBe(false);
		expect(binds.bound().map((entry) => entry.name)).toEqual(["other"]);
	});

	it("keeps surviving names sticky until a new session compacts them", () => {
		let known = [project("app", "/work/one"), project("app", "/work/two")];
		const session = createSessionBinds(() => known);
		const survivor = known[1];

		known = survivor === undefined ? [] : [survivor];

		expect(session.all().map((entry) => entry.name)).toEqual(["app-2"]);
		expect(
			createSessionBinds(() => known)
				.all()
				.map((entry) => entry.name),
		).toEqual(["app"]);
	});

	it("does not reuse a retired name until the session restarts", () => {
		const survivor = project("app", "/work/two");
		let known = [project("app", "/work/one"), survivor];
		const session = createSessionBinds(() => known);

		known = [survivor];
		session.sync();
		known = [...known, project("app", "/work/three")];

		expect(session.all().map((entry) => entry.name)).toEqual(["app-2", "app-3"]);
		expect(
			createSessionBinds(() => known)
				.all()
				.map((entry) => entry.name),
		).toEqual(["app-1", "app-2"]);
	});

	it("keeps independently derived names in simultaneous sessions", () => {
		let known = [project("app", "/work/one")];
		const older = createSessionBinds(() => known);
		known = [...known, project("app", "/work/two")];
		const newer = createSessionBinds(() => known);

		expect(older.sync().renames).toHaveLength(1);
		expect(newer.sync().renames).toEqual([]);
		expect(older.all().map((entry) => entry.name)).toEqual(newer.all().map((entry) => entry.name));
	});
});

describe("stores in directories of a project's choosing", () => {
	it("names a custom store after its workspace and directory, bound apart from the default", () => {
		const binds = createSessionBinds(() => [project("switchboard"), custom("switchboard", "/x/refs-store")]);

		expect(binds.all().map((entry) => entry.name)).toEqual(["switchboard", "switchboard:refs-store"]);
		expect(binds.bind("switchboard:refs-store")).toMatchObject({
			bound: true,
			project: { name: "switchboard:refs-store", stateDir: "/x/refs-store" },
		});
		expect(binds.all().map((entry) => `${entry.name}:${entry.bound}`)).toEqual([
			"switchboard:false",
			"switchboard:refs-store:true",
		]);

		binds.unbind("switchboard:refs-store");
		expect(binds.bound()).toEqual([]);
	});

	it("keeps the workspace's numbering under a collision, whether or not a default store exists", () => {
		const projects = [custom("app", "/x/refs", "/work/one"), project("app", "/work/two")];

		expect(
			createSessionBinds(() => projects)
				.all()
				.map((entry) => entry.name),
		).toEqual(["app-1:refs", "app-2"]);
	});

	it("keeps two custom stores sharing a basename apart", () => {
		const projects = [project("app"), custom("app", "/x/refs"), custom("app", "/y/refs")];

		expect(
			createSessionBinds(() => projects)
				.all()
				.map((entry) => entry.name),
		).toEqual(["app", "app:refs", "app:refs-2"]);
	});

	it("renames a custom store with its workspace, clearing a binding on it", () => {
		const first = custom("app", "/x/refs", "/work/one");
		let known = [first];
		const binds = createSessionBinds(() => known);
		binds.bind("app:refs");

		known = [...known, project("app", "/work/two")];

		expect(binds.sync()).toEqual({
			renames: [{ key: first.key, root: first.root, stateDir: "/x/refs", from: "app:refs", to: "app-1:refs" }],
			bindingsCleared: true,
		});
		expect(binds.all().map((entry) => entry.name)).toEqual(["app-1:refs", "app-2"]);
	});
});
