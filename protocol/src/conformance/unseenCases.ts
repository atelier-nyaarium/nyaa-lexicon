import { METHOD_SCHEMAS, type ModuleAdmission } from "../methods.js";
import { moduleOf } from "../symbolId.js";
import { PROTOCOL_VERSION } from "../version.js";
import { hashOf } from "./caseSupport.js";
import { CONFORMANCE_POLICY } from "./policy.js";
import type { MethodResponse } from "./providerSession.js";
import { ProviderSession, Stall } from "./providerSession.js";
import type { CaseResult, LifecycleCase, LifecycleFixture, VariantResult } from "./types.js";

/** Operations and observations for one case. */
interface LifecycleSteps {
	settle(text: string): Promise<MethodResponse<"parseFile">>;
	stage(text: string): Promise<MethodResponse<"parseFile">>;
	admit(text: string): Promise<void>;
	refuse(text: string): Promise<void>;
	probe(text: string, module?: string): Promise<void>;
	discover(): Promise<void>;
	forget(): Promise<void>;
	observe(): Promise<Map<string, unknown>>;
	renameEdits(text: string, oldName: string, newName: string): Promise<unknown>;
	moveEdits(
		text: string,
		declaration: MethodResponse<"parseFile">["declarations"][number],
		toModule: string,
	): Promise<unknown>;
}

/** Trial and control share a scenario. */
interface PairedVariant {
	name: string;
	description: string;
	kind: "paired";
	run(steps: LifecycleSteps, trial: boolean): Promise<void>;
}

/** A variant with direct checks. */
interface AssertionVariant {
	name: string;
	description: string;
	kind: "assertion";
	run(steps: LifecycleSteps): Promise<Map<string, unknown> | undefined>;
	check(
		observed: Map<string, unknown>,
		before: Map<string, unknown> | undefined,
		fixture: LifecycleFixture,
	): string[];
}

type UnseenVariant = PairedVariant | AssertionVariant;

interface ObservedReference {
	name: string;
	role: string;
	range: { start: { line: number; character: number }; end: { line: number; character: number } };
	binding: { status: string; symbolId?: string };
}

function rangeKey(range: ObservedReference["range"]): string {
	return `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
}

/** Capture request errors; preserve stalls. */
async function answerOf(ask: () => Promise<unknown>): Promise<unknown> {
	try {
		return await ask();
	} catch (error) {
		if (error instanceof Stall) throw error;
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

function stepsFor(session: ProviderSession, root: string, fixture: LifecycleFixture): LifecycleSteps {
	const { target } = fixture;
	const parse = (text: string, module = target) =>
		session.call("parseFile", { module, contentHash: hashOf(text), text });
	const verdict = (text: string, reason?: string) =>
		session.notify("moduleAdmission", {
			module: target,
			contentHash: hashOf(text),
			outcome: reason === undefined ? { status: "admitted" } : { status: "refused", reason },
		} satisfies ModuleAdmission);
	/** Prior references, rebound before reparse. */
	const observedReferences = new Map<string, ObservedReference[]>();
	return {
		settle: async (text) => {
			const facts = await parse(text);
			await verdict(text);
			return facts;
		},
		stage: (text) => parse(text),
		admit: (text) => verdict(text),
		refuse: (text) => verdict(text, "the index refused these facts"),
		probe: async (text, module = target) => {
			await session.call("probeFile", { module, contentHash: hashOf(text), text });
		},
		discover: async () => {
			await session.call("discoverProject", { workspaceRoot: root });
		},
		forget: () => session.notify("forgetModule", { module: target }),
		// Capture parse, binding, import, and type answers.
		observe: async () => {
			const seen = new Map<string, unknown>();
			const targets = new Set<string>();
			for (const [module, text] of Object.entries(fixture.files).sort(([a], [b]) => a.localeCompare(b))) {
				if (module === target) continue;
				// Bind prior ranges before restaging.
				for (const reference of observedReferences.get(module) ?? []) {
					const binding = await answerOf(() =>
						session.call("bind", { module, range: reference.range, name: reference.name }),
					);
					seen.set(`bind before parse ${module} ${reference.name} at ${rangeKey(reference.range)}`, binding);
				}
				const parsed = await answerOf(() =>
					session.call("parseFile", { module, contentHash: hashOf(text), text }),
				);
				seen.set(`parse ${module}`, parsed);
				const facts = parsed as { imports?: { specifier: string }[]; references?: ObservedReference[] };
				const references = facts.references ?? [];
				observedReferences.set(module, references);
				for (const reference of references) {
					if (reference.binding.status === "bound" && reference.binding.symbolId !== undefined) {
						targets.add(reference.binding.symbolId);
					}
					const range = rangeKey(reference.range);
					const binding = await answerOf(() =>
						session.call("bind", { module, range: reference.range, name: reference.name }),
					);
					seen.set(`bind ${module} ${reference.name} [${reference.role}] at ${range}`, binding);
					const bound = binding as { status?: string; symbolId?: string };
					if (bound.status === "bound" && bound.symbolId !== undefined) targets.add(bound.symbolId);
				}
				const imports = facts.imports ?? [];
				for (const { specifier } of imports) {
					const resolved = await answerOf(() =>
						session.call("resolveImport", { fromModule: module, specifier }),
					);
					seen.set(`import ${module} ${specifier}`, resolved);
				}
			}
			for (const symbolId of [...targets].sort()) {
				const type = await answerOf(() => session.call("typeOf", { symbolId }));
				seen.set(`typeOf ${symbolId}`, type);
			}
			return seen;
		},
		renameEdits: async (text, oldName, newName) => {
			const params = METHOD_SCHEMAS.renameEdits.request.parse({
				module: target,
				text,
				oldName,
				newName,
				sites: [],
				ownerCalls: [],
			});
			return answerOf(() => session.call("renameEdits", params));
		},
		moveEdits: async (text, declaration, toModule) => {
			const params = METHOD_SCHEMAS.moveEdits.request.parse({
				module: target,
				text,
				exists: true,
				symbolId: declaration.symbolId,
				name: declaration.name,
				fromModule: target,
				toModule,
				role: { removal: declaration.range },
				importSites: [],
				dependencies: [],
				sites: [],
			});
			return answerOf(() => session.call("moveEdits", params));
		},
	};
}

/** Compact report rendering. */
function gist(answer: unknown): string {
	if (answer === undefined) return "nothing";
	const value = answer as {
		error?: string;
		status?: string;
		module?: string;
		references?: { name: string; binding: { status: string; symbolId?: string } }[];
		declarations?: { name: string; symbolId: string }[];
		diagnostics?: { severity: string; message: string }[];
	};
	if (value.error !== undefined) return `a refusal (${value.error})`;
	if (value.references !== undefined) {
		const bindings = value.references.map(
			(reference) => `${reference.name} ${reference.binding.symbolId ?? reference.binding.status}`,
		);
		const declarations = (value.declarations ?? []).map(({ name, symbolId }) => `${name} ${symbolId}`);
		const diagnostics = (value.diagnostics ?? []).map(({ severity, message }) => `${severity} ${message}`);
		return `refs [${bindings.join(", ")}], declarations [${declarations.join(", ")}], diagnostics [${diagnostics.join(", ")}]`;
	}
	if (value.status !== undefined && value.module !== undefined) return `${value.status} ${value.module}`;
	const rendered = JSON.stringify(answer) ?? String(answer);
	return rendered.length > 220 ? `${rendered.slice(0, 217)}...` : rendered;
}

function boundTarget(
	observed: Map<string, unknown>,
	fixture: LifecycleFixture,
): { key: string; answer: unknown } | undefined {
	const parsed = observed.get(`parse ${fixture.user}`);
	if (parsed !== undefined && typeof parsed === "object" && parsed !== null && "references" in parsed) {
		const facts = parsed as MethodResponse<"parseFile">;
		for (const reference of facts.references) {
			if (reference.name !== fixture.name || reference.role === "import" || reference.role === "export") continue;
			if (reference.binding.status === "bound" && moduleOf(reference.binding.symbolId) === fixture.target) {
				return { key: `parse ${fixture.user}`, answer: reference.binding };
			}
			const range = `${reference.range.start.line}:${reference.range.start.character}-${reference.range.end.line}:${reference.range.end.character}`;
			const key = `bind ${fixture.user} ${reference.name} [${reference.role}] at ${range}`;
			const binding = observed.get(key) as { status?: string; symbolId?: string } | undefined;
			if (
				binding?.status === "bound" &&
				binding.symbolId !== undefined &&
				moduleOf(binding.symbolId) === fixture.target
			) {
				return { key, answer: binding };
			}
		}
	}
	return undefined;
}

function movedModule(module: string): string {
	const moved = module.replace(/(\.[^./]+)$/, "_moved$1");
	return moved === module ? `${module}_moved` : moved;
}

/** Compare isolated trials with fresh controls. */
async function runUnseenCase(
	command: string[],
	timeoutMs: number,
	root: string,
	testCase: LifecycleCase,
	fixture: LifecycleFixture,
): Promise<CaseResult> {
	const own = fixture.files[fixture.target] as string;
	const other = fixture.refusedText;
	const variants: UnseenVariant[] = [
		{
			name: "warm-probe",
			description: "A probe over admitted target facts leaves every observed answer unchanged.",
			kind: "paired",
			run: async (steps, trial) => {
				await steps.settle(own);
				await steps.observe();
				if (trial) await steps.probe(other);
			},
		},
		{
			name: "cold-probe",
			description: "A probe before any target parse leaves every observed answer unchanged.",
			kind: "paired",
			run: async (steps, trial) => {
				if (trial) await steps.probe(other);
			},
		},
		{
			name: "probe-across-staged-parse",
			description: "A probe above a pending parse leaves every observed answer unchanged.",
			kind: "paired",
			run: async (steps, trial) => {
				await steps.settle(own);
				await steps.stage(other);
				if (trial) await steps.probe(`${other}\n`);
				await steps.refuse(other);
			},
		},
		{
			name: "probe-after-rediscovery",
			description: "A probe after rediscovery leaves every observed answer unchanged.",
			kind: "paired",
			run: async (steps, trial) => {
				await steps.settle(own);
				await steps.discover();
				if (trial) await steps.probe(other);
			},
		},
		{
			name: "refused-parse",
			description: "Refusing a changed parse preserves the admitted facts.",
			kind: "paired",
			run: async (steps, trial) => {
				await steps.settle(own);
				if (!trial) return;
				await steps.stage(other);
				await steps.refuse(other);
			},
		},
		{
			name: "refused-verdict-after-rediscovery",
			description: "A refusal verdict after a second rediscovery preserves admitted facts.",
			kind: "paired",
			run: async (steps, trial) => {
				await steps.settle(own);
				await steps.discover();
				if (trial) await steps.stage(other);
				await steps.discover();
				if (trial) await steps.refuse(other);
			},
		},
		{
			name: "cold-refused-parse",
			description: "A cold refusal of changed text leaves no observable state.",
			kind: "paired",
			run: async (steps, trial) => {
				if (!trial) return;
				await steps.stage(other);
				await steps.refuse(other);
			},
		},
		{
			name: "refused-parse-after-one-rediscovery",
			description: "A refusal after one rediscovery preserves the admitted facts.",
			kind: "paired",
			run: async (steps, trial) => {
				await steps.settle(own);
				await steps.discover();
				if (!trial) return;
				await steps.stage(other);
				await steps.refuse(other);
			},
		},
		{
			name: "admission-after-rediscovery",
			description: "An admission after rediscovery makes the staged text visible in both runs.",
			kind: "paired",
			run: async (steps, trial) => {
				await steps.settle(own);
				await steps.discover();
				if (trial) await steps.stage(other);
				await steps.discover();
				if (trial) await steps.admit(other);
				else await steps.settle(other);
			},
		},
		{
			name: "probe-after-forget",
			description: "A probe after forgetting admitted target facts leaves every answer unchanged.",
			kind: "paired",
			run: async (steps, trial) => {
				await steps.settle(own);
				await steps.forget();
				if (trial) await steps.probe(other);
			},
		},
		{
			name: "two-refused-stages",
			description: "Two staged parses refused in order leave the admitted facts visible.",
			kind: "paired",
			run: async (steps, trial) => {
				await steps.settle(own);
				if (!trial) return;
				const later = `${other}\n`;
				await steps.stage(other);
				await steps.stage(later);
				await steps.refuse(other);
				await steps.refuse(later);
			},
		},
		{
			name: "probe-using-module",
			description: "Probing the using module with changed text leaves later answers unchanged.",
			kind: "paired",
			run: async (steps, trial) => {
				await steps.settle(own);
				await steps.observe();
				// Different candidate facts expose leaked bindings.
				if (trial) await steps.probe(other, fixture.user);
			},
		},
		{
			name: "rename-candidate-text",
			description: "Rename edits over changed candidate text leave later answers unchanged.",
			kind: "paired",
			run: async (steps, trial) => {
				await steps.settle(own);
				await steps.observe();
				if (trial) await steps.renameEdits(other, fixture.name, `${fixture.name}Next`);
			},
		},
		{
			name: "move-candidate-text",
			description: "Move edits over changed candidate text leave later answers unchanged.",
			kind: "paired",
			run: async (steps, trial) => {
				const facts = await steps.settle(own);
				await steps.observe();
				if (!trial) return;
				const declaration = facts.declarations.find(({ name }) => name === fixture.name);
				if (declaration === undefined) throw new Error(`fixture declaration ${fixture.name} was not parsed`);
				await steps.moveEdits(other, declaration, movedModule(fixture.target));
			},
		},
		{
			name: "cold-refusal-own-disk-bytes",
			description: "A cold refusal of the target disk bytes must not bind the fixture name.",
			kind: "assertion",
			run: async (steps) => {
				await steps.stage(own);
				await steps.refuse(own);
				return undefined;
			},
			check: (observed) => {
				const binding = boundTarget(observed, fixture);
				return binding === undefined
					? []
					: [
							`after a cold refusal of disk bytes, ${fixture.name} binds into ${fixture.target}: ${gist(binding.answer)}`,
						];
			},
		},
		{
			name: "fill-then-refuse-disk-bytes",
			description: "A refusal of disk bytes already observed from disk must not bind the fixture name.",
			kind: "assertion",
			run: async (steps) => {
				const before = await steps.observe();
				await steps.stage(own);
				await steps.refuse(own);
				return before;
			},
			check: (observed, before) => {
				const problems: string[] = [];
				if (before === undefined || boundTarget(before, fixture) === undefined) {
					problems.push(`setup did not bind ${fixture.name} into ${fixture.target} during the disk fill`);
				}
				const binding = boundTarget(observed, fixture);
				if (binding !== undefined) {
					problems.push(
						`after refusing observed disk bytes, ${fixture.name} binds into ${fixture.target}: ${gist(binding.answer)}`,
					);
				}
				return problems;
			},
		},
	];

	const observed = async (variant: PairedVariant, trial: boolean): Promise<Map<string, unknown>> => {
		const session = ProviderSession.open(command, timeoutMs);
		try {
			await session.call("initialize", {
				workspaceRoot: root,
				protocolVersion: PROTOCOL_VERSION,
				policy: CONFORMANCE_POLICY,
			});
			await session.call("discoverProject", { workspaceRoot: root });
			const steps = stepsFor(session, root, fixture);
			await variant.run(steps, trial);
			return await steps.observe();
		} finally {
			await session.close();
		}
	};

	const problems: string[] = [];
	const variantResults: VariantResult[] = [];
	for (const [index, variant] of variants.entries()) {
		let variantProblems: string[];
		if (variant.kind === "paired") {
			const [control, trial] = await Promise.all([observed(variant, false), observed(variant, true)]);
			// Require cross-file binding before comparing results.
			if (index === 0) {
				if (boundTarget(control, fixture) === undefined) {
					const bindings = [...control.entries()]
						.filter(([key]) => key.startsWith(`bind ${fixture.user} `))
						.map(([key, answer]) => `${key}: ${gist(answer)}`);
					return {
						caseId: testCase.id,
						tier: "binding",
						outcome: "skipped",
						problems: [
							`${fixture.user} does not bind ${fixture.name} into ${fixture.target}, so this provider holds no cross-file state for the case to watch; parse ${gist(control.get(`parse ${fixture.user}`))}; ${bindings.join("; ")}`,
						],
					};
				}
			}
			variantProblems = [];
			for (const key of new Set([...control.keys(), ...trial.keys()])) {
				const before = control.get(key);
				const after = trial.get(key);
				if (JSON.stringify(before) === JSON.stringify(after)) continue;
				variantProblems.push(`${variant.name} changed ${key}: ${gist(before)} became ${gist(after)}`);
			}
		} else {
			const session = ProviderSession.open(command, timeoutMs);
			try {
				await session.call("initialize", {
					workspaceRoot: root,
					protocolVersion: PROTOCOL_VERSION,
					policy: CONFORMANCE_POLICY,
				});
				await session.call("discoverProject", { workspaceRoot: root });
				const steps = stepsFor(session, root, fixture);
				const before = await variant.run(steps);
				variantProblems = variant.check(await steps.observe(), before, fixture);
			} finally {
				await session.close();
			}
		}
		variantResults.push({
			name: variant.name,
			description: variant.description,
			outcome: variantProblems.length === 0 ? "passed" : "failed",
			problems: variantProblems,
		});
		problems.push(...variantProblems);
	}
	return {
		caseId: testCase.id,
		tier: "binding",
		outcome: problems.length === 0 ? "passed" : "failed",
		problems,
		variants: variantResults,
	};
}

export { runUnseenCase };
