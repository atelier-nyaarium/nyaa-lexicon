// The kit owns provider state across parses.

import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import { hashContent } from "./hash.js";
import type { METHOD_SCHEMAS, ModuleAdmission, ProviderMethod } from "./methods.js";
import type { IndexDepth } from "./project.js";
import type { ProviderHandlers, ProviderNotificationHandlers } from "./serve.js";
import { readSourceFile } from "./sourceFile.js";
import type { Diagnostic } from "./symbols.js";
import { workspaceFile } from "./workspacePath.js";

////////////////////////////////
//  Interfaces & Types

type Request<M extends ProviderMethod> = z.infer<(typeof METHOD_SCHEMAS)[M]["request"]>;
type Response<M extends ProviderMethod> = z.infer<(typeof METHOD_SCHEMAS)[M]["response"]>;

export type Maybe<T> = T | Promise<T>;

/** Error diagnostics block a fill. */
export interface ModuleValue {
	readonly diagnostics: readonly Diagnostic[];
}

export interface Held {
	readonly text: string;
	/** Hash computed by the kit. */
	readonly contentHash: string;
	readonly depth: IndexDepth;
}

/** Parse request or kit fill. */
export type Origin = "parse" | "fill";

/** Compute index entries from one module. */
export type Entries<V, P, E> = (
	module: string,
	value: V,
	held: Held,
	project: P,
	origin: Origin,
) => Iterable<readonly [key: string, entry: E]>;

export interface StoreSpec<V extends ModuleValue, P, E> {
	/** Parse one module; fills use outline depth. */
	read(module: string, text: string, depth: IndexDepth): V;
	/** No read tells them apart, so the shown value is kept. */
	same?(a: V, b: V): boolean;
	entries?: Entries<V, P, E>;
	/** Fills add no entries; `get` skips the fill pass. */
	indexParsesOnly?: boolean;
}

export interface AsyncStoreSpec<V extends ModuleValue, P, E> {
	read(module: string, text: string, depth: IndexDepth): Promise<V>;
	/** No read tells them apart, so the shown value is kept. */
	same?(a: V, b: V): boolean;
	entries?: Entries<V, P, E>;
	/** Fills add no entries; `get` skips the fill pass. */
	indexParsesOnly?: boolean;
}

interface StoreReads<P> {
	readonly root: string;
	/** Throws before discovery. */
	readonly project: P;
	/** Moves with a visible value, index entry, withheld mark or project. */
	readonly generation: number;
	/** Forgotten modules cannot be filled. */
	withheld(module: string): boolean;
	/** Discovered and visible modules, sorted. */
	modules(): readonly string[];
	/** Cached once per key and generation. */
	memo<R>(key: string, compute: () => R): R;
}

/** Provider API with transient writes only. */
export interface ModuleStore<V, P, E> extends StoreReads<P> {
	/** Return a visible value, filling as needed. */
	load(module: string, depth?: "full"): V | undefined;
	peek(module: string): V | undefined;
	text(module: string): Held | undefined;
	/** Return entries, filling first when enabled. */
	get(key: string): readonly E[];
	/** Temporary view; nested views throw. */
	withText<R>(module: string, text: string, run: (value: V) => R): R;
}

export interface AsyncModuleStore<V, P, E> extends StoreReads<P> {
	load(module: string, depth?: "full"): Promise<V | undefined>;
	peek(module: string): V | undefined;
	text(module: string): Promise<Held | undefined>;
	/** Return entries, filling first when enabled. */
	get(key: string): Promise<readonly E[]>;
	withText<R>(module: string, text: string, run: (value: V) => Maybe<R>): Promise<R>;
}

/** Stateful provider backed by the kit's store. */
export interface StoreProvider<V extends ModuleValue, P, E> {
	readonly store: ModuleStore<V, P, E> | AsyncModuleStore<V, P, E>;
	initialize(workspaceRoot: string): Response<"initialize">;
	/** Refresh project configuration. */
	discoverProject(
		workspaceRoot: string,
		previous: P | undefined,
	): Maybe<{ model: Response<"discoverProject">; project: P }>;
	/** Answer after the kit exposes the parsed value. */
	parseFile(params: Request<"parseFile">, value: V): Maybe<Response<"parseFile">>;
	resolveImport(params: Request<"resolveImport">): Maybe<Response<"resolveImport">>;
	bind(params: Request<"bind">): Maybe<Response<"bind">>;
	typeOf(params: Request<"typeOf">): Maybe<Response<"typeOf">>;
	renameEdits(params: Request<"renameEdits">): Maybe<Response<"renameEdits">>;
	moveEdits(params: Request<"moveEdits">): Maybe<Response<"moveEdits">>;
	shutdown?(): void;
}

interface Layer<V> {
	readonly held: Held;
	readonly origin: Origin;
	readonly value: V;
	/** Cached full-depth parse. */
	deep?: Maybe<V> | undefined;
}

type Base<V> =
	| { readonly kind: "unknown"; readonly refused?: string; readonly missed?: boolean }
	/** Refusal marks survive temporary fills. */
	| { readonly kind: "held"; readonly layer: Layer<V>; readonly refused?: string }
	| { readonly kind: "withheld" };

interface Staged<V> {
	readonly requestHash: string;
	/** Hash request text even if reading fails. */
	readonly textHash: string;
	/** Added after the value is built. */
	layer?: Layer<V>;
}

interface Slot<V> {
	base: Base<V>;
	/** Oldest parse first. */
	chain: Staged<V>[];
	transient?: Layer<V> | undefined;
}

////////////////////////////////
//  Constants

const UNKNOWN = { kind: "unknown" } as const;

/** Provider stores map to their owning kit. */
const kits = new WeakMap<object, Kit<ModuleValue, unknown, unknown>>();

/** Enable deep-freeze and repeat-read checks. */
const CHECKS = process.env["LEXICON_STORE_CHECKS"] === "1";

////////////////////////////////
//  Functions & Helpers

function after<T, R>(value: Maybe<T>, next: (resolved: T) => Maybe<R>): Maybe<R> {
	return value instanceof Promise ? value.then(next) : next(value);
}

/** Freeze plain objects and arrays recursively. */
function freezeDeep(value: unknown, seen: Set<object>): void {
	if (typeof value !== "object" || value === null || seen.has(value)) return;
	const prototype = Object.getPrototypeOf(value);
	if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return;
	seen.add(value);
	Object.freeze(value);
	for (const child of Object.values(value)) freezeDeep(child, seen);
}

function sameEntry(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	const keys = Object.keys(a);
	return (
		keys.length === Object.keys(b).length &&
		keys.every((key) => Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
	);
}

function refusable(value: ModuleValue): boolean {
	return value.diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

////////////////////////////////
//  Class

class Kit<V extends ModuleValue, P, E> {
	root = "";
	generation = 0;
	private discovery: { project: P } | null = null;
	private discovered = new Set<string>();
	private readonly slots = new Map<string, Slot<V>>();
	/** Discovered modules awaiting a fill. */
	private readonly owed = new Set<string>();
	private readonly index = new Map<string, Map<string, readonly E[]>>();
	private readonly contributed = new Map<string, readonly string[]>();
	private readonly ordered = new Map<string, readonly E[]>();
	private readonly memos = new Map<string, { generation: number; value: unknown }>();
	private readonly filling = new Map<string, Promise<void>>();
	private transientOpen = false;

	constructor(
		private readonly spec: {
			read(m: string, t: string, d: IndexDepth): Maybe<V>;
			same?(a: V, b: V): boolean;
			entries?: Entries<V, P, E>;
			indexParsesOnly?: boolean;
		},
		/** Enable repeat reads for synchronous stores. */
		private readonly rereads: boolean,
	) {}

	get project(): P {
		if (this.discovery === null) throw new Error("no project has been discovered yet");
		return this.discovery.project;
	}

	get discoveredOnce(): boolean {
		return this.discovery !== null;
	}

	previousProject(): P | undefined {
		return this.discovery?.project;
	}

	////////////////////////////////
	//  Writes

	reset(root: string): void {
		this.root = path.resolve(root);
		this.discovery = null;
		this.discovered = new Set();
		this.slots.clear();
		this.owed.clear();
		this.index.clear();
		this.contributed.clear();
		this.ordered.clear();
		this.memos.clear();
		this.filling.clear();
		this.transientOpen = false;
		this.generation++;
	}

	/** Drop fills; preserve admitted values and refusal marks. */
	rediscover(root: string, files: readonly string[], project: P): void {
		this.root = path.resolve(root);
		this.discovery = { project };
		this.discovered = new Set(files);
		this.owed.clear();
		for (const slot of this.slots.values()) {
			const base = slot.base;
			const filled = base.kind === "held" && base.layer.origin === "fill";
			if (filled || (base.kind === "unknown" && base.missed === true)) {
				slot.base = base.refused === undefined ? UNKNOWN : { kind: "unknown", refused: base.refused };
			}
		}
		for (const module of this.discovered) {
			if ((this.slots.get(module)?.base ?? UNKNOWN).kind === "unknown") this.owed.add(module);
		}
		this.index.clear();
		this.contributed.clear();
		this.ordered.clear();
		for (const module of this.slots.keys()) this.writeEntries(module, this.entriesOf(module, this.visible(module)));
		this.generation++;
	}

	/** Staged values show before admission. */
	stage<R>(
		module: string,
		requestHash: string,
		text: string,
		depth: IndexDepth,
		answer: (value: V) => Maybe<R>,
	): Maybe<R> {
		const slot = this.slot(module);
		// Stage before parsing so failures still get verdicts.
		const entry: Staged<V> = { requestHash, textHash: hashContent(text) };
		slot.chain.push(entry);
		return after(this.layerFor(module, text, depth, "parse"), (layer) => {
			this.change(module, () => {
				entry.layer = layer;
			});
			return answer(layer.value);
		});
	}

	/** Apply the oldest parse verdict. */
	settle(verdict: ModuleAdmission): void {
		const slot = this.slots.get(verdict.module);
		const oldest = slot?.chain[0];
		if (slot === undefined || oldest === undefined || oldest.requestHash !== verdict.contentHash) return;
		this.change(verdict.module, () => {
			slot.chain.shift();
			if (verdict.outcome.status === "admitted") {
				if (oldest.layer !== undefined) slot.base = { kind: "held", layer: oldest.layer };
				this.owed.delete(verdict.module);
				return;
			}
			const refused = oldest.textHash;
			const base = slot.base;
			// Refusal drops any fill base.
			const filled = base.kind === "held" && base.layer.origin === "fill";
			if (base.kind !== "unknown" && !filled) return;
			slot.base = { kind: "unknown", refused };
			if (this.discovered.has(verdict.module)) this.owed.add(verdict.module);
		});
	}

	/** Hide a module until admission. */
	forget(module: string): void {
		const slot = this.slot(module);
		this.change(module, () => {
			slot.base = { kind: "withheld" };
			slot.chain = [];
		});
		this.owed.delete(module);
	}

	/** Candidate view; removed when the callback settles. */
	transient<R>(module: string, text: string, depth: IndexDepth, run: (value: V) => Maybe<R>): Maybe<R> {
		if (this.transientOpen) throw new Error("a transient layer is already open");
		this.transientOpen = true;
		const slot = this.slot(module);
		const pop = () => {
			this.change(module, () => {
				slot.transient = undefined;
			});
			this.transientOpen = false;
		};
		let result: Maybe<R>;
		try {
			result = after(this.layerFor(module, text, depth, "parse"), (layer) => {
				this.change(module, () => {
					slot.transient = layer;
				});
				return run(layer.value);
			});
		} catch (error) {
			pop();
			throw error;
		}
		if (result instanceof Promise) return result.finally(pop);
		pop();
		return result;
	}

	////////////////////////////////
	//  Reads

	peek(module: string): V | undefined {
		return this.visible(module)?.value;
	}

	withheld(module: string): boolean {
		return this.visible(module) === undefined && this.slots.get(module)?.base.kind === "withheld";
	}

	modules(): readonly string[] {
		return this.memo("\0modules", () => {
			const shown = [...this.slots.keys()].filter((module) => this.visible(module) !== undefined);
			return [...new Set([...this.discovered, ...shown])].sort();
		});
	}

	load(module: string, depth?: "full"): Maybe<V | undefined> {
		return after(this.ensure(module), () => {
			const layer = this.visible(module);
			if (layer === undefined) return undefined;
			if (depth !== "full" || layer.held.depth === "full") return layer.value;
			if (layer.deep === undefined) {
				const deep = after(this.spec.read(module, layer.held.text, "full"), (value) =>
					this.frozen(module, layer.held.text, "full", value),
				);
				layer.deep = deep instanceof Promise ? deep.catch((error) => this.forgetDeep(layer, error)) : deep;
			}
			return layer.deep;
		});
	}

	text(module: string): Maybe<Held | undefined> {
		return after(this.ensure(module), () => this.visible(module)?.held);
	}

	get(key: string): Maybe<readonly E[]> {
		// Parse-only specs skip fill draining.
		return after(this.spec.indexParsesOnly === true ? undefined : this.drain(), () => {
			const cached = this.ordered.get(key);
			if (cached !== undefined) return cached;
			const byModule = this.index.get(key);
			const entries =
				byModule === undefined
					? []
					: [...byModule.keys()].sort().flatMap((module) => byModule.get(module) as readonly E[]);
			this.ordered.set(key, entries);
			return entries;
		});
	}

	memo<R>(key: string, compute: () => R): R {
		const hit = this.memos.get(key);
		if (hit !== undefined && hit.generation === this.generation) return hit.value as R;
		const value = compute();
		// Cache against the generation after compute.
		this.memos.set(key, { generation: this.generation, value });
		return value;
	}

	////////////////////////////////
	//  Internals

	private slot(module: string): Slot<V> {
		let slot = this.slots.get(module);
		if (slot === undefined) {
			slot = { base: UNKNOWN, chain: [] };
			this.slots.set(module, slot);
		}
		return slot;
	}

	/** Transient, newest built stage, then base layer. */
	private visible(module: string): Layer<V> | undefined {
		const slot = this.slots.get(module);
		if (slot === undefined) return undefined;
		if (slot.transient !== undefined) return slot.transient;
		for (let at = slot.chain.length - 1; at >= 0; at--) {
			const layer = slot.chain[at]?.layer;
			if (layer !== undefined) return layer;
		}
		return slot.base.kind === "held" ? slot.base.layer : undefined;
	}

	/** Build or reuse a held layer. */
	private layerFor(module: string, text: string, depth: IndexDepth, origin: Origin): Maybe<Layer<V>> {
		const contentHash = hashContent(text);
		const shown = this.visible(module);
		if (shown !== undefined && shown.held.contentHash === contentHash && shown.held.depth === depth) {
			if (shown.origin === origin) return shown;
			// Drop pending refinements across origins.
			return { ...shown, origin, deep: shown.deep instanceof Promise ? undefined : shown.deep };
		}
		const held: Held = { text, contentHash, depth };
		return after(this.spec.read(module, text, depth), (read) => {
			const value = this.frozen(module, text, depth, read);
			const kept = shown?.held.contentHash === contentHash && this.spec.same?.(shown.value, value) === true;
			return { held, origin, value: kept ? shown.value : value };
		});
	}

	/** Advance on value, entry, or withholding changes. */
	private change(module: string, mutate: () => void): void {
		const before = this.visible(module);
		const wasWithheld = this.withheld(module);
		mutate();
		const next = this.visible(module);
		if (before === next) {
			if (wasWithheld !== this.withheld(module)) this.generation++;
			return;
		}
		const entries = this.entriesOf(module, next);
		const entriesMoved = !this.sameEntries(module, entries);
		if (entriesMoved) this.writeEntries(module, entries);
		if (entriesMoved || before?.value !== next?.value || wasWithheld !== this.withheld(module)) this.generation++;
	}

	private entriesOf(module: string, layer: Layer<V> | undefined): Map<string, E[]> {
		const grouped = new Map<string, E[]>();
		const entriesOf = this.spec.entries;
		if (entriesOf === undefined || layer === undefined || this.discovery === null) return grouped;
		// Skip fill layers in parse-only indexes.
		if (this.spec.indexParsesOnly === true && layer.origin === "fill") return grouped;
		for (const [key, entry] of entriesOf(module, layer.value, layer.held, this.discovery.project, layer.origin)) {
			const list = grouped.get(key);
			if (list === undefined) grouped.set(key, [entry]);
			else list.push(entry);
		}
		return grouped;
	}

	/** Compare entries by key and shallow value. */
	private sameEntries(module: string, grouped: Map<string, E[]>): boolean {
		const keys = this.contributed.get(module) ?? [];
		if (keys.length !== grouped.size) return false;
		return keys.every((key) => {
			const was = this.index.get(key)?.get(module);
			const now = grouped.get(key);
			return (
				was !== undefined &&
				now !== undefined &&
				was.length === now.length &&
				now.every((entry, at) => sameEntry(entry, was[at]))
			);
		});
	}

	private writeEntries(module: string, grouped: Map<string, E[]>): void {
		for (const key of this.contributed.get(module) ?? []) {
			this.index.get(key)?.delete(module);
			this.ordered.delete(key);
		}
		this.contributed.delete(module);
		if (grouped.size === 0) return;
		for (const [key, list] of grouped) {
			let byModule = this.index.get(key);
			if (byModule === undefined) {
				byModule = new Map();
				this.index.set(key, byModule);
			}
			byModule.set(module, list);
			this.ordered.delete(key);
		}
		this.contributed.set(module, [...grouped.keys()]);
	}

	private ensure(module: string): Maybe<void> {
		if (this.visible(module) !== undefined) return;
		return this.fill(module);
	}

	/** Fill each owed module in sorted order. */
	private drain(): Maybe<void> {
		const pending: Promise<void>[] = [];
		for (const module of [...this.owed].sort()) {
			const done = this.fill(module);
			if (done instanceof Promise) pending.push(done);
		}
		return pending.length === 0 ? undefined : Promise.all(pending).then(() => undefined);
	}

	/** Read and validate one module. */
	private fill(module: string): Maybe<void> {
		const running = this.filling.get(module);
		if (running !== undefined) return running;
		const slot = this.slot(module);
		const base = slot.base;
		if (base.kind !== "unknown" || base.missed === true) {
			this.owed.delete(module);
			return;
		}
		const absolute = workspaceFile(this.root, module);
		const read = absolute === null ? ({ kind: "missing" } as const) : readSourceFile(absolute);
		// Retry unreadable files on later reads.
		if (read.kind === "unreadable") return;
		const contentHash = read.kind === "text" && read.lossless ? hashContent(read.text) : undefined;
		if (read.kind !== "text" || contentHash === undefined || contentHash === base.refused) {
			this.miss(module, slot);
			return;
		}
		const held: Held = { text: read.text, contentHash, depth: "outline" };
		const land = (value: V): void => {
			// Recheck after parsing.
			if (this.slots.get(module) !== slot || slot.base !== base) return;
			if (refusable(value)) {
				this.miss(module, slot);
				return;
			}
			const layer: Layer<V> = { held, origin: "fill", value: this.frozen(module, read.text, "outline", value) };
			this.change(module, () => {
				slot.base = { kind: "held", layer, ...(base.refused === undefined ? {} : { refused: base.refused }) };
			});
			this.owed.delete(module);
		};
		let value: Maybe<V>;
		try {
			value = this.spec.read(module, read.text, "outline");
		} catch {
			return this.miss(module, slot);
		}
		if (!(value instanceof Promise)) return land(value);
		const pending = value.then(land, () => this.miss(module, slot)).finally(() => this.filling.delete(module));
		this.filling.set(module, pending);
		return pending;
	}

	/** Misses retry after discovery. */
	private miss(module: string, slot: Slot<V>): void {
		const base = slot.base;
		if (this.slots.get(module) === slot && base.kind === "unknown") {
			slot.base = {
				kind: "unknown",
				missed: true,
				...(base.refused === undefined ? {} : { refused: base.refused }),
			};
		}
		this.owed.delete(module);
	}

	private forgetDeep(layer: Layer<V>, error: unknown): never {
		layer.deep = undefined;
		throw error;
	}

	/** In check mode, deep-freeze and verify repeat reads. */
	private frozen(module: string, text: string, depth: IndexDepth, value: V): V {
		if (!CHECKS) return Object.freeze(value);
		freezeDeep(value, new Set());
		if (this.rereads && !isDeepStrictEqual(value, this.spec.read(module, text, depth)))
			throw new Error(`${module}: two reads of one text disagree`);
		return value;
	}
}

/** Provider-facing store view. */
function readSide<V extends ModuleValue, P, E, S extends object>(kit: Kit<V, P, E>, reads: S): StoreReads<P> & S {
	const store = Object.assign(
		{
			withheld: (module: string) => kit.withheld(module),
			modules: () => kit.modules(),
			memo: <R>(key: string, compute: () => R) => kit.memo(key, compute),
			peek: (module: string) => kit.peek(module),
		},
		reads,
	);
	Object.defineProperties(store, {
		root: { get: () => kit.root, enumerable: true },
		project: { get: () => kit.project, enumerable: true },
		generation: { get: () => kit.generation, enumerable: true },
	});
	kits.set(store, kit as unknown as Kit<ModuleValue, unknown, unknown>);
	return store as unknown as StoreReads<P> & S;
}

export function moduleStore<V extends ModuleValue, P = null, E = never>(
	spec: StoreSpec<V, P, E>,
): ModuleStore<V, P, E> {
	const kit = new Kit<V, P, E>(spec, true);
	return readSide(kit, {
		load: (module: string, depth?: "full") => kit.load(module, depth) as V | undefined,
		text: (module: string) => kit.text(module) as Held | undefined,
		get: (key: string) => kit.get(key) as readonly E[],
		withText: <R>(module: string, text: string, run: (value: V) => R) =>
			kit.transient(module, text, "full", run) as R,
	}) as ModuleStore<V, P, E>;
}

export function asyncModuleStore<V extends ModuleValue, P = null, E = never>(
	spec: AsyncStoreSpec<V, P, E>,
): AsyncModuleStore<V, P, E> {
	const kit = new Kit<V, P, E>(spec, false);
	return readSide(kit, {
		load: async (module: string, depth?: "full") => kit.load(module, depth),
		text: async (module: string) => kit.text(module),
		get: async (key: string) => kit.get(key),
		withText: async <R>(module: string, text: string, run: (value: V) => Maybe<R>) =>
			kit.transient(module, text, "full", run),
	}) as AsyncModuleStore<V, P, E>;
}

/** Route provider requests through the kit. */
export function storeHandlersFor<V extends ModuleValue, P, E>(
	provider: StoreProvider<V, P, E>,
): ProviderHandlers & ProviderNotificationHandlers {
	const kit = kits.get(provider.store) as Kit<V, P, E> | undefined;
	if (kit === undefined) throw new Error("the provider's store was not made by moduleStore or asyncModuleStore");
	const discover = (root: string) =>
		after(provider.discoverProject(root, kit.previousProject()), ({ model, project }) => {
			kit.rediscover(root, model.files, project);
			return model;
		});
	// Discover before the first request.
	const ready = <R>(work: () => Maybe<R>): Maybe<R> =>
		kit.discoveredOnce ? work() : after(discover(kit.root), work);
	const handlers = {
		initialize: (params: Request<"initialize">) => {
			kit.reset(params.workspaceRoot);
			return provider.initialize(params.workspaceRoot);
		},
		discoverProject: (params: Request<"discoverProject">) => discover(params.workspaceRoot),
		parseFile: (params: Request<"parseFile">) =>
			ready(() =>
				kit.stage(params.module, params.contentHash, params.text, params.depth ?? "full", (value) =>
					provider.parseFile(params, value),
				),
			),
		probeFile: (params: Request<"probeFile">) =>
			ready(() =>
				kit.transient(params.module, params.text, params.depth ?? "full", (value) =>
					provider.parseFile(params, value),
				),
			),
		resolveImport: (params: Request<"resolveImport">) => ready(() => provider.resolveImport(params)),
		bind: (params: Request<"bind">) => ready(() => provider.bind(params)),
		typeOf: (params: Request<"typeOf">) => ready(() => provider.typeOf(params)),
		renameEdits: (params: Request<"renameEdits">) =>
			ready(() => kit.transient(params.module, params.text, "full", () => provider.renameEdits(params))),
		moveEdits: (params: Request<"moveEdits">) =>
			ready(() => kit.transient(params.module, params.text, "full", () => provider.moveEdits(params))),
		moduleAdmission: (verdict: ModuleAdmission) => kit.settle(verdict),
		forgetModule: (params: { module: string }) => kit.forget(params.module),
		shutdown: () => {
			provider.shutdown?.();
			kit.reset(kit.root);
			return {};
		},
	};
	// The server awaits promise results.
	return handlers as unknown as ProviderHandlers & ProviderNotificationHandlers;
}
