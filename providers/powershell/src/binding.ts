import {
	type Binding,
	comparePositions,
	defined,
	type ImportResolution,
	type Position,
	type UnknownReason,
	walkImportGraph,
	walkImportGraphEntries,
} from "@nyaa-lexicon/protocol";
import { keyOf, type MemberFilter, wildcardMatches } from "./context.js";
import type { ParsedPowerShellFile, PowerShellDeclaration, PowerShellReference, SourceImport } from "./extract.js";
import { membersOf, parameterOf } from "./scope.js";

type Unresolved = Exclude<ImportResolution, { status: "resolved" }>;
type MemberKind = "function" | "variable";
type Sought = Pick<Settling, "kind" | "name">;
type Through = { gates: ParsedPowerShellFile[]; filters: MemberFilter[]; inModule: boolean };

interface Settling {
	kind: MemberKind;
	name: string;
	report: (status: Unresolved, specifier: string) => void;
}

interface Left {
	scope?: PowerShellDeclaration;
	global?: PowerShellDeclaration;
	caller?: PowerShellDeclaration;
	scopeAt?: Position;
	globalAt?: Position;
}

interface Binder {
	declaration: PowerShellDeclaration;
	at: Position;
}

interface IndexedSource {
	source: SourceImport;
	index: number;
}

interface RootOwn {
	binder: Binder | undefined;
}

interface BindingState {
	module: string;
	facts?: ParsedPowerShellFile | undefined;
	factsLoaded?: boolean;
	settling: Settling;
	through: Through;
	caller: Through;
	before?: Position;
	rootOwn?: RootOwn;
	focus?: IndexedSource;
	single: boolean;
	stop: boolean;
	moduleGate?: boolean;
}

interface ReachState {
	module: string;
	facts?: ParsedPowerShellFile | undefined;
}

export interface BindingHost {
	factsFor(module: string): ParsedPowerShellFile | null;
	resolveImport(params: { fromModule: string; specifier: string }): ImportResolution;
}

function unbound(reason: UnknownReason, detail: string): Binding {
	return { status: "unbound", reason, detail };
}

function bound(symbolId: string): Binding {
	return { status: "bound", symbolId, provenance: "bound" };
}

function signature(through: Through): string {
	return JSON.stringify([through.gates.map((gate) => gate.module), through.filters, through.inModule]);
}

function direct(module: string): Through {
	const key = keyOf(module);
	return { gates: [], filters: [], inModule: key.endsWith(".psm1") || key.endsWith(".psd1") };
}

function importLevel(source: SourceImport, through: Through): "scope" | "global" {
	if (source.scope !== undefined) return source.scope === "local" ? "scope" : "global";
	return through.inModule ? "scope" : "global";
}

function unprefixed(name: string, prefix: string): string | undefined {
	const dash = name.indexOf("-");
	const verb = dash < 0 ? "" : name.slice(0, dash + 1);
	const noun = name.slice(verb.length);
	if (noun.length <= prefix.length || !keyOf(noun).startsWith(keyOf(prefix))) return undefined;
	return verb + noun.slice(prefix.length);
}

function importedName(sought: Sought, source: SourceImport): string | undefined {
	const prefix = source.prefix;
	if (sought.kind === "variable" || prefix === undefined) return sought.name;
	return prefix.kind === "static" ? unprefixed(sought.name, prefix.text) : undefined;
}

function binderOf(
	facts: ParsedPowerShellFile,
	declaration: PowerShellDeclaration,
	before?: Position,
): Binder | undefined {
	let at: Position | undefined;
	const consider = (position: Position) => {
		if (before !== undefined && comparePositions(position, before) >= 0) return;
		if (at === undefined || comparePositions(position, at) > 0) at = position;
	};
	consider(declaration.range.start);
	if (declaration.kind === "variable") {
		for (const reference of facts.references) {
			if (
				reference.role === "write" &&
				reference.of.kind === "variable" &&
				reference.fromId === undefined &&
				reference.target === declaration.symbolId
			)
				consider(reference.range.start);
		}
	}
	return at === undefined ? undefined : { declaration, at };
}

function visible(left: Left): PowerShellDeclaration | undefined {
	return left.scope ?? left.global;
}

function soughtBy(reference: PowerShellReference): Sought | undefined {
	switch (reference.of.kind) {
		case "command":
			return { kind: "function", name: reference.name };
		case "variable":
			return { kind: "variable", name: reference.name };
		case "parameter":
			return { kind: "function", name: reference.of.command };
		case "type":
		case "member":
			return undefined;
	}
}

function exports(gate: ParsedPowerShellFile, kind: MemberKind, name: string): boolean {
	const patterns = kind === "function" ? gate.exportedFunctions : gate.exportedVariables;
	if (patterns === undefined) return kind === "function" || keyOf(gate.module).endsWith(".psd1");
	return [...patterns].some((pattern) => wildcardMatches(pattern, name));
}

function admits(filter: MemberFilter, kind: MemberKind, name: string): boolean {
	const patterns = kind === "function" ? filter.functions : filter.variables;
	return patterns.some((pattern) => wildcardMatches(pattern, name));
}

function ownDefinition(facts: ParsedPowerShellFile, through: Through, sought: Sought): Binder | undefined {
	const { kind, name } = sought;
	const declaration =
		kind === "function"
			? facts.functionsByName
					.get(keyOf(name))
					?.filter((definition) => definition.visibility === "public")
					.at(-1)
			: facts.variablesByName.get(keyOf(name));
	if (declaration === undefined) return undefined;
	const shown =
		through.gates.every((gate) => exports(gate, kind, declaration.name)) &&
		through.filters.every((filter) => admits(filter, kind, declaration.name));
	return shown ? binderOf(facts, declaration) : undefined;
}

function typeCandidates(facts: ParsedPowerShellFile, reference: PowerShellReference): PowerShellDeclaration[] {
	if (reference.of.kind === "member")
		return membersOf(facts.typesByName, reference.of.typeName, reference.name, reference.of.arity);
	const type = facts.typesByName.get(keyOf(reference.name));
	return type === undefined ? [] : [type];
}

export function dropsWhenUnbound(reference: PowerShellReference): boolean {
	switch (reference.of.kind) {
		case "command":
		case "type":
		case "member":
		case "parameter":
			return true;
		case "variable":
			return false;
	}
}

export class PowerShellBinding {
	constructor(private readonly host: BindingHost) {}

	bindReference(module: string, parsed: ParsedPowerShellFile, reference: PowerShellReference): Binding {
		const sought = soughtBy(reference);
		const target = reference.target;
		const kept =
			sought === undefined ||
			reference.fromId !== undefined ||
			(reference.of.kind === "variable" && reference.role === "write");
		if (target !== undefined && kept) return bound(target);
		let reason: UnknownReason = "NotIndexed";
		let detail = `no PowerShell declaration matches ${reference.name}`;
		const report = (status: Unresolved, specifier: string) => {
			if (status.status === "external") {
				reason = "ExternalDependency";
				detail = `${reference.name} may come from ${specifier}, outside the workspace`;
			} else {
				reason = status.reason;
				detail = status.detail ?? detail;
			}
		};
		const candidates = new Set<string>();
		if (sought === undefined) {
			const own = reference.of.kind === "member" ? [parsed] : [];
			for (const facts of [...own, ...this.reachable(module, parsed, report)]) {
				for (const declaration of typeCandidates(facts, reference)) candidates.add(declaration.symbolId);
			}
		} else {
			const settling: Settling = { ...sought, report };
			const start = direct(module);
			const initialOwn = reference.fromId === undefined ? this.ownBinder(parsed, reference) : undefined;
			const memo = new Map<string, Left>();
			const settled =
				reference.fromId === undefined
					? [
							visible(
								this.settled(
									{
										module,
										facts: parsed,
										settling,
										through: start,
										caller: start,
										before: reference.range.start,
										rootOwn: { binder: initialOwn },
										single: false,
										stop: false,
									},
									memo,
								),
							),
						]
					: parsed.sources.map((source, index) =>
							visible(
								this.settled(
									{
										module,
										facts: parsed,
										settling,
										through: start,
										caller: start,
										focus: { source, index },
										single: true,
										stop: false,
									},
									memo,
								),
							),
						);
			for (const declaration of settled) {
				const found =
					declaration !== undefined && reference.of.kind === "parameter"
						? parameterOf(declaration, reference.name)
						: declaration;
				if (found !== undefined) candidates.add(found.symbolId);
			}
		}
		if (candidates.size === 1) return bound([...candidates][0] as string);
		if (candidates.size > 1) return { status: "ambiguous", candidates: [...candidates], provenance: "bound" };
		return unbound(reason, detail);
	}

	typeSymbol(module: string, typeName: string): string | undefined {
		const facts = this.host.factsFor(module);
		if (facts === null) return undefined;
		const own = facts.typesByName.get(keyOf(typeName));
		if (own !== undefined) return own.symbolId;
		const zero = { line: 0, character: 0 };
		const binding = this.bindReference(module, facts, {
			name: typeName,
			range: { start: zero, end: zero },
			role: "typeUse",
			of: { kind: "type" },
			qualified: false,
		});
		return binding.status === "bound" ? binding.symbolId : undefined;
	}

	private settled(root: BindingState, memo: Map<string, Left>): Left {
		return walkImportGraph(
			root,
			{
				module: (state) => state.module,
				key: (state) => this.stateKey(state),
				imports: (state) => {
					if (state.stop) return [];
					const facts = this.facts(state);
					if (facts === null) return [];
					if (state.single) return state.focus === undefined ? [] : [state.focus];
					return facts.sources.flatMap((source, index) =>
						state.before !== undefined && comparePositions(source.range.start, state.before) >= 0
							? []
							: [{ source, index }],
					);
				},
				resolve: (state, edge) => this.resolveState(state, edge),
				initial: (state) => this.initialLeft(state),
				apply: (state, edge, current, child) => this.applyImport(state, edge, current, child),
			},
			memo,
		);
	}

	private facts(state: BindingState): ParsedPowerShellFile | null {
		if (state.facts !== undefined) return state.facts;
		if (state.factsLoaded !== true) {
			state.facts = this.host.factsFor(state.module) ?? undefined;
			state.factsLoaded = true;
		}
		return state.facts ?? null;
	}

	private initialLeft(state: BindingState): Left {
		const facts = this.facts(state);
		if (state.stop || facts === null) return {};
		if (state.moduleGate) {
			state.through = { ...state.through, gates: [...state.through.gates, facts] };
			state.moduleGate = false;
		}
		const own =
			state.rootOwn === undefined ? ownDefinition(facts, state.through, state.settling) : state.rootOwn.binder;
		return own === undefined ? {} : { scope: own.declaration, scopeAt: own.at };
	}

	private resolveState(state: BindingState, edge: IndexedSource): BindingState | undefined {
		const { source } = edge;
		const resolution = this.host.resolveImport({ fromModule: state.module, specifier: source.specifier });
		if (resolution.status !== "resolved") {
			state.settling.report(resolution, source.specifier);
			return undefined;
		}
		const { landing } = resolution;
		if (landing.kind !== "module") return undefined;
		if (source.kind === "dotSource")
			return {
				module: landing.module,
				settling: state.settling,
				through: state.through,
				caller: state.caller,
				single: false,
				stop: false,
			};
		if (source.kind === "importerScript")
			return {
				module: landing.module,
				settling: state.settling,
				through: state.caller,
				caller: state.caller,
				single: false,
				stop: false,
			};
		const name = importedName(state.settling, source);
		if (name === undefined)
			return {
				module: landing.module,
				settling: state.settling,
				through: state.through,
				caller: state.caller,
				single: false,
				stop: true,
			};
		const inner: Through = {
			gates: [...state.through.gates],
			filters: source.filter === undefined ? state.through.filters : [...state.through.filters, source.filter],
			inModule: true,
		};
		return {
			module: landing.module,
			settling: { ...state.settling, name },
			through: inner,
			caller: state.through,
			single: false,
			stop: false,
			moduleGate: true,
		};
	}

	private applyImport(state: BindingState, edge: IndexedSource, current: Left, child: Left | undefined): Left {
		const brought = this.broughtIn(state, edge.source, child);
		if (state.single) return brought;
		const at = edge.source.range.start;
		const left = { ...current };
		const later = (since: Position | undefined) => since === undefined || comparePositions(at, since) >= 0;
		if (brought.scope !== undefined && later(left.scopeAt)) {
			left.scope = brought.scope;
			left.scopeAt = at;
		}
		if (brought.global !== undefined && later(left.globalAt)) {
			left.global = brought.global;
			left.globalAt = at;
		}
		if (brought.caller !== undefined) left.caller = brought.caller;
		return left;
	}

	private broughtIn(state: BindingState, source: SourceImport, child: Left | undefined): Left {
		if (child === undefined) return {};
		if (source.kind === "dotSource") return child;
		if (source.kind === "importerScript") return defined({ caller: child.scope, global: child.global });
		const members = visible(child);
		return importLevel(source, state.through) === "scope"
			? defined({ scope: members ?? child.caller })
			: defined({ scope: child.caller, global: members });
	}

	private stateKey(state: BindingState): string {
		return JSON.stringify([
			state.module,
			state.settling.kind,
			state.settling.name,
			signature(state.through),
			signature(state.caller),
			state.before,
			state.rootOwn?.binder?.declaration.symbolId,
			state.rootOwn?.binder?.at,
			state.focus?.index,
			state.single,
			state.stop,
			state.moduleGate,
		]);
	}

	private ownBinder(parsed: ParsedPowerShellFile, reference: PowerShellReference): Binder | undefined {
		const id = reference.of.kind === "variable" ? reference.target : reference.callee;
		const declaration = parsed.declarations.find((candidate) => candidate.symbolId === id);
		return declaration === undefined ? undefined : binderOf(parsed, declaration, reference.range.start);
	}

	private reachable(
		module: string,
		parsed: ParsedPowerShellFile,
		report: Settling["report"],
	): ParsedPowerShellFile[] {
		const found = walkImportGraphEntries<ReachState, IndexedSource, string>(
			{ module, facts: parsed },
			{
				module: (state) => state.module,
				key: (state) => state.module,
				imports: (state) => {
					state.facts ??= this.host.factsFor(state.module) ?? undefined;
					return state.facts?.sources.map((source, index) => ({ source, index })) ?? [];
				},
				resolve: (state, edge) => {
					const resolution = this.host.resolveImport({
						fromModule: state.module,
						specifier: edge.source.specifier,
					});
					if (resolution.status !== "resolved") {
						report(resolution, edge.source.specifier);
						return undefined;
					}
					if (resolution.landing.kind !== "module") return undefined;
					return { module: resolution.landing.module };
				},
			},
			new Map(),
			"breadthFirst",
		);
		return found.flatMap(({ state }) => (state.facts === undefined ? [] : [state.facts]));
	}
}
