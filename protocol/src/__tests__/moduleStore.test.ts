import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashContent } from "../hash";
import {
	asyncModuleStore,
	type Held,
	type ModuleStore,
	type ModuleValue,
	moduleStore,
	type Origin,
	type StoreProvider,
} from "../moduleStore";
import type { IndexDepth, ProjectModel } from "../project";
import { handlersFor } from "../providerKit";

////////////////////////////////
//  Fixtures

/** Toy parser for store tests. */
interface Toy extends ModuleValue {
	text: string;
	names: string[];
}

const MODULES = ["a.toy", "b.toy", "c.toy", "d.toy"];
const TEXTS = ["x", "x y", "y z", "z w", "w", "x z!", "boom"];
const KEYS = ["name:x", "name:y", "name:z", "name:w", "parsed"];

const roots: string[] = [];

function read(_module: string, text: string, _depth: IndexDepth): Toy {
	if (text === "boom") throw new Error("boom");
	const names = text.split(/\s+/).filter((name) => name.length > 0 && !name.includes("!"));
	return { text, names, diagnostics: text.includes("!") ? [{ severity: "error", message: "bang" }] : [] };
}

function* entries(
	module: string,
	value: Toy,
	_held: Held,
	_project: null,
	origin: Origin,
): Iterable<readonly [string, string]> {
	for (const name of value.names) yield [`name:${name}`, module];
	if (origin === "parse") yield ["parsed", module];
}

function model(root: string): ProjectModel {
	return { files: readdirSync(root).sort(), externalRoots: [], configFiles: [], diagnostics: [] };
}

function toy(store: ModuleStore<Toy, null, string>, root: string, onParse?: (value: Toy) => void) {
	const provider: StoreProvider<Toy, null, string> = {
		store,
		initialize: () => ({}) as never,
		discoverProject: (workspaceRoot) => ({ model: model(workspaceRoot), project: null }),
		parseFile: (_params, value) => {
			onParse?.(value);
			return value as never;
		},
		resolveImport: () => ({}) as never,
		bind: () => ({}) as never,
		typeOf: () => ({}) as never,
		renameEdits: () => ({}) as never,
		moveEdits: () => ({}) as never,
	};
	const handlers = handlersFor(provider);
	handlers.initialize({ workspaceRoot: root, protocolVersion: "0" } as never);
	handlers.discoverProject({ workspaceRoot: root });
	return handlers;
}

function workspace(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-module-store-"));
	roots.push(root);
	for (const [module, text] of Object.entries(files)) writeFileSync(path.join(root, module), text);
	return root;
}

/** Deterministic history. */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

type SpecBase =
	| { kind: "unknown"; refused?: string; missed?: boolean }
	| { kind: "held"; text: string; origin: Origin; refused?: string }
	| { kind: "withheld" };

/** Reference model for store histories. */
class Spec {
	readonly disk = new Map<string, string>();
	private readonly base = new Map<string, SpecBase>();
	private readonly chain = new Map<string, { requestHash: string; text: string; read: boolean }[]>();
	private owed = new Set<string>();
	private discovered: string[] = [];

	private baseOf(module: string): SpecBase {
		return this.base.get(module) ?? { kind: "unknown" };
	}

	private chainOf(module: string) {
		let list = this.chain.get(module);
		if (list === undefined) {
			list = [];
			this.chain.set(module, list);
		}
		return list;
	}

	visible(module: string): { text: string; origin: "parse" | "fill" } | undefined {
		const staged = [...this.chainOf(module)].reverse().find((entry) => entry.read);
		if (staged !== undefined) return { text: staged.text, origin: "parse" };
		const base = this.baseOf(module);
		return base.kind === "held" ? { text: base.text, origin: base.origin } : undefined;
	}

	withheld(module: string): boolean {
		return this.visible(module) === undefined && this.baseOf(module).kind === "withheld";
	}

	fill(module: string): void {
		const base = this.baseOf(module);
		if (base.kind !== "unknown" || base.missed === true) {
			this.owed.delete(module);
			return;
		}
		const text = this.disk.get(module);
		const missed = {
			kind: "unknown",
			missed: true,
			...(base.refused === undefined ? {} : { refused: base.refused }),
		};
		if (text === undefined || hashContent(text) === base.refused || text.includes("!") || text === "boom") {
			this.base.set(module, missed as SpecBase);
		} else {
			this.base.set(module, {
				kind: "held",
				text,
				origin: "fill",
				...(base.refused === undefined ? {} : { refused: base.refused }),
			});
		}
		this.owed.delete(module);
	}

	load(module: string): string | undefined {
		if (this.visible(module) === undefined) this.fill(module);
		return this.visible(module)?.text;
	}

	drain(): void {
		for (const module of [...this.owed].sort()) this.fill(module);
	}

	stage(module: string, requestHash: string, text: string): void {
		this.chainOf(module).push({ requestHash, text, read: text !== "boom" });
	}

	settle(module: string, requestHash: string, admitted: boolean): void {
		const list = this.chainOf(module);
		const oldest = list[0];
		if (oldest === undefined || oldest.requestHash !== requestHash) return;
		list.shift();
		if (admitted) {
			if (oldest.read) this.base.set(module, { kind: "held", text: oldest.text, origin: "parse" });
			this.owed.delete(module);
			return;
		}
		const refused = hashContent(oldest.text);
		const base = this.baseOf(module);
		if (base.kind === "unknown" || (base.kind === "held" && base.origin === "fill")) {
			this.base.set(module, { kind: "unknown", refused });
			if (this.discovered.includes(module)) this.owed.add(module);
		}
	}

	forget(module: string): void {
		this.base.set(module, { kind: "withheld" });
		this.chain.set(module, []);
		this.owed.delete(module);
	}

	rediscover(): void {
		this.discovered = [...this.disk.keys()].sort();
		for (const [module, base] of this.base) {
			const filled = base.kind === "held" && base.origin === "fill";
			if (filled || (base.kind === "unknown" && base.missed === true)) {
				this.base.set(
					module,
					base.refused === undefined ? { kind: "unknown" } : { kind: "unknown", refused: base.refused },
				);
			}
		}
		this.owed = new Set(this.discovered.filter((module) => this.baseOf(module).kind === "unknown"));
	}

	/** Visible entries grouped by key. */
	index(): Map<string, string[]> {
		const found = new Map<string, string[]>(KEYS.map((key) => [key, []]));
		for (const module of MODULES) {
			const shown = this.visible(module);
			if (shown === undefined) continue;
			const held = { text: shown.text, contentHash: hashContent(shown.text), depth: "full" } as const;
			for (const [key, entry] of entries(module, read(module, shown.text, "full"), held, null, shown.origin)) {
				found.get(key)?.push(entry);
			}
		}
		return found;
	}
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("the module store against the rules as plain data", () => {
	it("agrees on every visible text, withheld mark, load and index over random histories", () => {
		for (let seed = 1; seed <= 300; seed++) {
			const next = random(seed);
			const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
			const root = workspace({});
			const spec = new Spec();
			for (const module of MODULES) {
				if (next() < 0.75) {
					const text = pick(TEXTS);
					writeFileSync(path.join(root, module), text);
					spec.disk.set(module, text);
				}
			}
			const store = moduleStore<Toy, null, string>({ read, entries });
			const handlers = toy(store, root);
			spec.rediscover();
			const history: string[] = [];
			const staged = new Map<string, string[]>();

			for (let step = 0; step < 40; step++) {
				const module = pick(MODULES);
				const roll = next();
				if (roll < 0.25) {
					const text = pick(TEXTS);
					const requestHash = `r${seed}:${step}`;
					history.push(`stage ${module} ${text}`);
					spec.stage(module, requestHash, text);
					staged.set(module, [...(staged.get(module) ?? []), requestHash]);
					try {
						handlers.parseFile({ module, contentHash: requestHash, text });
					} catch {}
				} else if (roll < 0.45) {
					const oldest = staged.get(module)?.[0];
					if (oldest === undefined) continue;
					staged.set(module, (staged.get(module) ?? []).slice(1));
					const admitted = next() < 0.5;
					history.push(`settle ${module} ${admitted ? "admitted" : "refused"}`);
					spec.settle(module, oldest, admitted);
					handlers.moduleAdmission?.({
						module,
						contentHash: oldest,
						outcome: admitted ? { status: "admitted" } : { status: "refused", reason: "no" },
					});
				} else if (roll < 0.55) {
					const text = pick(TEXTS);
					history.push(`probe ${module} ${text}`);
					try {
						handlers.probeFile({ module, contentHash: "probe", text });
					} catch {}
				} else if (roll < 0.62) {
					history.push(`forget ${module}`);
					spec.forget(module);
					staged.set(module, []);
					handlers.forgetModule?.({ module });
				} else if (roll < 0.7) {
					const text = next() < 0.2 ? undefined : pick(TEXTS);
					history.push(`disk ${module} ${text ?? "(gone)"}`);
					if (text === undefined) {
						spec.disk.delete(module);
						try {
							unlinkSync(path.join(root, module));
						} catch {}
					} else {
						spec.disk.set(module, text);
						writeFileSync(path.join(root, module), text);
					}
				} else if (roll < 0.76) {
					history.push("rediscover");
					spec.rediscover();
					handlers.discoverProject({ workspaceRoot: root });
				} else if (roll < 0.9) {
					history.push(`load ${module}`);
					expect({ history, text: store.load(module)?.text }).toEqual({ history, text: spec.load(module) });
				} else {
					history.push("index");
					spec.drain();
					const expected = spec.index();
					expect({ history, index: KEYS.map((key) => [key, store.get(key)]) }).toEqual({
						history,
						index: KEYS.map((key) => [key, expected.get(key) ?? []]),
					});
				}
				for (const each of MODULES) {
					expect({ history, each, text: store.peek(each)?.text, withheld: store.withheld(each) }).toEqual({
						history,
						each,
						text: spec.visible(each)?.text,
						withheld: spec.withheld(each),
					});
				}
			}
		}
	});
});

describe("the module store's verdicts", () => {
	it("settles only the oldest parse by its hash, and ignores a verdict after a forget", () => {
		const root = workspace({ "a.toy": "x" });
		const store = moduleStore<Toy, null, string>({ read, entries });
		const handlers = toy(store, root);
		const verdict = (contentHash: string, admitted: boolean) =>
			handlers.moduleAdmission?.({
				module: "a.toy",
				contentHash,
				outcome: admitted ? { status: "admitted" } : { status: "refused", reason: "no" },
			});
		handlers.parseFile({ module: "a.toy", contentHash: "h1", text: "y" });
		handlers.parseFile({ module: "a.toy", contentHash: "h2", text: "z" });
		verdict("h2", false);
		verdict("elsewhere", false);
		const ignored = store.peek("a.toy")?.text;
		verdict("h1", true);
		verdict("h2", false);
		const settled = store.peek("a.toy")?.text;
		handlers.parseFile({ module: "a.toy", contentHash: "h3", text: "w" });
		handlers.forgetModule?.({ module: "a.toy" });
		verdict("h3", true);

		expect({ ignored, settled, forgotten: store.peek("a.toy")?.text, withheld: store.withheld("a.toy") }).toEqual({
			ignored: "z",
			settled: "y",
			forgotten: undefined,
			withheld: true,
		});
	});

	it("marks refused bytes even when their read threw, so no fill takes them", () => {
		const shallowOnly = (module: string, text: string, depth: IndexDepth): Toy => {
			if (text === "deep" && depth === "full") throw new Error("deep");
			return read(module, text, depth);
		};
		const root = workspace({ "a.toy": "x" });
		const store = moduleStore<Toy, null, string>({ read: shallowOnly, entries });
		const handlers = toy(store, root);
		const filled = store.load("a.toy")?.text;
		writeFileSync(path.join(root, "a.toy"), "deep");
		expect(() => handlers.parseFile({ module: "a.toy", contentHash: "h", text: "deep" })).toThrow();
		handlers.moduleAdmission?.({
			module: "a.toy",
			contentHash: "h",
			outcome: { status: "refused", reason: "threw" },
		});

		expect({ filled, after: store.load("a.toy")?.text }).toEqual({ filled: "x", after: undefined });
	});

	it("reads no unread module for an index only parses feed, and keeps fills out of it", () => {
		const root = workspace({ "a.toy": "x", "b.toy": "x" });
		const store = moduleStore<Toy, null, string>({ read, entries, indexParsesOnly: true });
		const handlers = toy(store, root);
		const unread = { index: store.get("name:x"), peek: store.peek("a.toy")?.text };
		store.load("b.toy");
		handlers.parseFile({ module: "a.toy", contentHash: "h", text: "x" });

		expect({ unread, index: store.get("name:x") }).toEqual({
			unread: { index: [], peek: undefined },
			index: ["a.toy"],
		});
	});

	it("rebuilds index entries from the new project value at a rediscovery", () => {
		const root = workspace({ "a.toy": "x" });
		let prefix = "one";
		const store = moduleStore<Toy, string, string>({
			read,
			*entries(module, value, _held, project) {
				for (const name of value.names) yield [`${project}:${name}`, module];
			},
		});
		const handlers = handlersFor<Toy, string, string>({
			store,
			initialize: () => ({}) as never,
			discoverProject: (workspaceRoot: string) => ({ model: model(workspaceRoot), project: prefix }),
			parseFile: (_params: unknown, value: Toy) => value as never,
			resolveImport: () => ({}) as never,
			bind: () => ({}) as never,
			typeOf: () => ({}) as never,
			renameEdits: () => ({}) as never,
			moveEdits: () => ({}) as never,
		});
		handlers.initialize({ workspaceRoot: root, protocolVersion: "0" } as never);
		handlers.discoverProject({ workspaceRoot: root });
		const before = store.get("one:x");
		prefix = "two";
		const generation = store.generation;
		handlers.discoverProject({ workspaceRoot: root });

		expect({
			before,
			old: store.get("one:x"),
			now: store.get("two:x"),
			moved: store.generation !== generation,
		}).toEqual({ before: ["a.toy"], old: [], now: ["a.toy"], moved: true });
	});
});

describe("the module store's fills", () => {
	it("misses a module whose real path leaves the workspace, and fills one linked inside", () => {
		const elsewhere = workspace({ "secret.toy": "y" });
		const root = workspace({ "a.toy": "x" });
		symlinkSync(path.join(elsewhere, "secret.toy"), path.join(root, "b.toy"));
		symlinkSync(path.join(root, "a.toy"), path.join(root, "c.toy"));
		const store = moduleStore<Toy, null, string>({ read, entries });
		toy(store, root);

		expect({
			outside: store.load("b.toy"),
			inside: store.load("c.toy")?.text,
			y: store.get("name:y"),
			x: store.get("name:x"),
		}).toEqual({ outside: undefined, inside: "x", y: [], x: ["a.toy", "c.toy"] });
	});
});

describe("the module store's layers", () => {
	it("shows a probe's text while it runs, and leaves the same value and index behind", () => {
		const root = workspace({ "a.toy": "x", "b.toy": "y" });
		const store = moduleStore<Toy, null, string>({ read, entries });
		let during: string | undefined;
		const handlers = toy(store, root, (value) => {
			during = store.peek("a.toy")?.text === value.text ? value.text : "not visible";
		});
		handlers.parseFile({ module: "a.toy", contentHash: "h", text: "x" });
		const before = { value: store.peek("a.toy"), index: KEYS.map((key) => store.get(key)) };
		handlers.probeFile({ module: "a.toy", contentHash: "p", text: "w z" });

		expect({
			during,
			sameValue: store.peek("a.toy") === before.value,
			index: KEYS.map((key) => store.get(key)),
		}).toEqual({
			during: "w z",
			sameValue: true,
			index: before.index,
		});
	});

	it("moves nothing for a parse of the text it already shows", () => {
		const root = workspace({ "a.toy": "x" });
		const store = moduleStore<Toy, null, string>({ read, entries });
		const handlers = toy(store, root);
		handlers.parseFile({ module: "a.toy", contentHash: "h1", text: "x" });
		const generation = store.generation;
		const value = store.peek("a.toy");
		handlers.parseFile({ module: "a.toy", contentHash: "h2", text: "x" });

		expect({ moved: store.generation !== generation, same: store.peek("a.toy") === value }).toEqual({
			moved: false,
			same: true,
		});
	});

	it("keeps the shown value for a deeper parse of the same bytes only when the spec calls the values the same", () => {
		const deeper = (same: ((a: Toy, b: Toy) => boolean) | undefined) => {
			const root = workspace({ "a.toy": "x" });
			const store = moduleStore<Toy, null, string>({ read, ...(same === undefined ? {} : { same }) });
			const handlers = toy(store, root);
			const filled = store.load("a.toy");
			const generation = store.generation;
			handlers.parseFile({ module: "a.toy", contentHash: "h", text: "x" });
			return { moved: store.generation !== generation, kept: store.peek("a.toy") === filled };
		};

		expect({ identity: deeper(undefined), textual: deeper((a, b) => a.text === b.text) }).toEqual({
			identity: { moved: true, kept: false },
			textual: { moved: false, kept: true },
		});
	});

	it("moves the generation for a parse of the filled bytes only when an entry sees the new origin", () => {
		const moved = (entriesOf: typeof entries | undefined) => {
			const root = workspace({ "a.toy": "x" });
			const store = moduleStore<Toy, null, string>({
				read,
				...(entriesOf === undefined ? {} : { entries: entriesOf }),
			});
			const handlers = toy(store, root);
			const filled = store.load("a.toy");
			const generation = store.generation;
			handlers.parseFile({ module: "a.toy", contentHash: "h", text: "x", depth: "outline" });
			return { moved: store.generation !== generation, same: store.peek("a.toy") === filled };
		};

		expect({ originBlind: moved(undefined), originSeen: moved(entries) }).toEqual({
			originBlind: { moved: false, same: true },
			originSeen: { moved: true, same: true },
		});
	});

	it("moves the generation when a module nothing read is forgotten", () => {
		const root = workspace({ "a.toy": "x" });
		const store = moduleStore<Toy, null, string>({ read, entries });
		const handlers = toy(store, root);
		const generation = store.generation;
		handlers.forgetModule?.({ module: "a.toy" });

		expect({ moved: store.generation !== generation, withheld: store.withheld("a.toy") }).toEqual({
			moved: true,
			withheld: true,
		});
	});

	it("drops a disk read the index outdated by refusing newer bytes", () => {
		const root = workspace({ "a.toy": "x" });
		const store = moduleStore<Toy, null, string>({ read, entries });
		const handlers = toy(store, root);
		const filled = store.load("a.toy")?.text;
		writeFileSync(path.join(root, "a.toy"), "y");
		handlers.parseFile({ module: "a.toy", contentHash: "h", text: "y" });
		handlers.moduleAdmission?.({ module: "a.toy", contentHash: "h", outcome: { status: "refused", reason: "no" } });

		expect({ filled, after: store.load("a.toy")?.text, x: store.get("name:x") }).toEqual({
			filled: "x",
			after: undefined,
			x: [],
		});
	});

	it("drops its own disk reads at a rediscovery, and reads the disk again", () => {
		const root = workspace({ "a.toy": "x" });
		const store = moduleStore<Toy, null, string>({ read, entries });
		const handlers = toy(store, root);
		const before = store.load("a.toy")?.text;
		writeFileSync(path.join(root, "a.toy"), "y");
		handlers.discoverProject({ workspaceRoot: root });

		expect({ before, after: store.load("a.toy")?.text }).toEqual({ before: "x", after: "y" });
	});

	it("refuses a transient layer inside another", () => {
		const root = workspace({ "a.toy": "x" });
		const store = moduleStore<Toy, null, string>({ read, entries });
		toy(store, root);

		expect(() => store.withText("a.toy", "y", () => store.withText("a.toy", "z", () => 0))).toThrow();
		expect(store.load("a.toy")?.text).toBe("x");
	});

	it("keeps what the index admitted across a rediscovery, and restores it after a refusal that lands after one", () => {
		const root = workspace({ "a.toy": "x" });
		const store = moduleStore<Toy, null, string>({ read, entries });
		const handlers = toy(store, root);
		handlers.parseFile({ module: "a.toy", contentHash: "h1", text: "x" });
		handlers.moduleAdmission?.({ module: "a.toy", contentHash: "h1", outcome: { status: "admitted" } });
		writeFileSync(path.join(root, "a.toy"), "y");
		handlers.discoverProject({ workspaceRoot: root });
		handlers.parseFile({ module: "a.toy", contentHash: "h2", text: "y" });
		handlers.discoverProject({ workspaceRoot: root });
		handlers.moduleAdmission?.({
			module: "a.toy",
			contentHash: "h2",
			outcome: { status: "refused", reason: "no" },
		});

		expect(store.get("name:x")).toEqual(["a.toy"]);
	});

	it("shares one async fill between concurrent loads", async () => {
		const root = workspace({ "a.toy": "x" });
		let reads = 0;
		const store = asyncModuleStore<Toy, null, string>({
			read: async (module, text, depth) => {
				reads++;
				await Bun.sleep(5);
				return read(module, text, depth);
			},
		});
		const handlers = handlersFor({
			store,
			initialize: () => ({}) as never,
			discoverProject: (workspaceRoot: string) => ({ model: model(workspaceRoot), project: null }),
			parseFile: (_params: unknown, value: Toy) => value as never,
			resolveImport: () => ({}) as never,
			bind: () => ({}) as never,
			typeOf: () => ({}) as never,
			renameEdits: () => ({}) as never,
			moveEdits: () => ({}) as never,
		});
		handlers.initialize({ workspaceRoot: root, protocolVersion: "0" } as never);
		handlers.discoverProject({ workspaceRoot: root });
		const [first, second] = await Promise.all([store.load("a.toy"), store.load("a.toy")]);

		expect({ reads, first: first?.text, same: first === second }).toEqual({ reads: 1, first: "x", same: true });
	});
});
