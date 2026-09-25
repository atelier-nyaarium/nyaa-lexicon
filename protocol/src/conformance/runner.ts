// Runs the corpus against a provider process. Depends on the protocol alone, never on the core, so
// a provider team can prove its own work without waiting for anything else to exist.

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import path from "node:path";
import { createMessageConnection, ErrorCodes, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import type { z } from "zod";
import { applyEdits } from "../edits.js";
import type { ModuleAdmission } from "../methods.js";
import { METHOD_SCHEMAS, type ProviderMethod, type ProviderNotification, type ProviderTiers } from "../methods.js";
import { composeSymbolId, moduleOf } from "../symbolId.js";
import { PROTOCOL_VERSION } from "../version.js";
import { checkFacts, checkImport, checkType } from "./check.js";
import {
	type CaseOutcome,
	type CaseResult,
	type ConformanceCase,
	type ConformanceFixtureSchema,
	type LifecycleCase,
	type LifecycleFixture,
	type MoveCase,
	type MoveFixture,
	type SuiteReport,
	type Tier,
	TierSchema,
	type VariantResult,
} from "./types.js";

////////////////////////////////
//  Interfaces & Types

type MethodResponse<K extends ProviderMethod> = z.infer<(typeof METHOD_SCHEMAS)[K]["response"]>;

type ConformanceFixture = z.infer<typeof ConformanceFixtureSchema>;

export interface RunOptions {
	/** Argv of the provider process, e.g. ["bun", "run", "providers/typescript/src/main.ts"]. */
	command: string[];
	cases: ConformanceCase[];
	moveCases?: MoveCase[];
	lifecycleCases?: LifecycleCase[];
	/** Milliseconds any single request may take before the case is failed. */
	timeoutMs?: number;
}

////////////////////////////////
//  Constants

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Case and fixture fields that state no expectation. Everything else earns a parse.
 *
 * Exported so one residue can hold it against both schemas: a field in neither this set nor the
 * checker's table is classified by nobody, and silently earns a parse it may not want.
 */
export const CASE_METADATA = new Set(["id", "tier", "about", "fixtures", "files", "subject", "discovery"]);

////////////////////////////////
//  Functions & Helpers

function writeFixture(root: string, files: Record<string, string>): void {
	for (const [relative, contents] of Object.entries(files)) {
		const full = path.join(root, relative);
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, contents);
	}
}

/** Content hash stand-in. The suite only needs it to be stable per text, not cryptographic. */
function hashOf(text: string): string {
	let h = 5381;
	for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
	return `h${(h >>> 0).toString(16)}`;
}

/** Machine or process, never answer. */
class Stall extends Error {
	constructor(
		readonly why: "timeout" | "exit",
		message: string,
	) {
		super(message);
	}
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const bounded = new Promise<T>((_, reject) => {
		timer = setTimeout(() => reject(new Stall("timeout", `${what} timed out after ${ms}ms`)), ms);
	});
	return Promise.race([work, bounded]).finally(() => clearTimeout(timer));
}

/** Busy machine or broken provider. */
function environment(startedAt: number, timeoutMs: number): string {
	const [load] = loadavg();
	return `timeout ${timeoutMs}ms, load ${(load ?? 0).toFixed(2)} on ${cpus().length} cpus, ${Math.round((Date.now() - startedAt) / 1000)}s into the run`;
}

function stalled(
	caseId: string,
	tier: Tier | "protocol",
	stall: Stall,
	startedAt: number,
	timeoutMs: number,
): CaseResult {
	return { caseId, tier, outcome: "stalled", problems: [`${stall.message} (${environment(startedAt, timeoutMs)})`] };
}

////////////////////////////////
//  Class

/** Owns the child process and the connection, so a caller sees requests and not a transport. */
class ProviderSession {
	/** Set at death. */
	private gone: string | null = null;
	/** Calls in flight, failed at death. Never raced against a promise that outlives the call. */
	private readonly inFlight = new Set<(stall: Stall) => void>();

	private constructor(
		private readonly child: ChildProcess,
		private readonly connection: ReturnType<typeof createMessageConnection>,
		private readonly timeoutMs: number,
	) {
		const die = (how: string) => {
			this.gone ??= how;
			const stall = new Stall("exit", `provider process ${how}`);
			for (const reject of this.inFlight) reject(stall);
			this.inFlight.clear();
		};
		child.once("exit", (code, signal) => die(`exited (${signal === null ? `code ${code}` : signal})`));
		child.once("error", (error) => die(`failed to start (${error.message})`));
		connection.onClose(() => die("closed its connection"));
	}

	static open(command: string[], timeoutMs: number): ProviderSession {
		const [bin, ...args] = command as [string, ...string[]];
		const child = spawn(bin, args, { stdio: ["pipe", "pipe", "inherit"] });
		if (!child.stdin || !child.stdout) throw new Error("provider process has no stdio pipes");
		const connection = createMessageConnection(
			new StreamMessageReader(child.stdout),
			new StreamMessageWriter(child.stdin),
		);
		connection.listen();
		return new ProviderSession(child, connection, timeoutMs);
	}

	/**
	 * Validates the response against the method table, so a malformed answer fails here rather
	 * than as a confusing mismatch inside a check.
	 *
	 * The cast is the one place the table's guarantee outruns what the compiler can prove for a
	 * generic key: `parse` really did produce this method's response shape, or it threw.
	 */
	async call<K extends ProviderMethod>(method: K, params: unknown): Promise<MethodResponse<K>> {
		if (this.gone !== null) throw new Stall("exit", `provider process ${this.gone} before ${method}`);
		let raw: unknown;
		try {
			const answer = new Promise<unknown>((resolve, reject) => {
				this.inFlight.add(reject);
				this.connection
					.sendRequest(method, params)
					.then(resolve, reject)
					.finally(() => this.inFlight.delete(reject));
			});
			raw = await withTimeout(answer, this.timeoutMs, method);
		} catch (error) {
			if (error instanceof Stall) {
				throw error.why === "exit" ? new Stall("exit", `${error.message} during ${method}`) : error;
			}
			if ((error as { code?: number }).code === ErrorCodes.PendingResponseRejected) {
				throw new Stall("exit", `provider process ${this.gone ?? "dropped the connection"} during ${method}`);
			}
			throw error;
		}
		return METHOD_SCHEMAS[method].response.parse(raw) as MethodResponse<K>;
	}

	/**
	 * Told, not asked. Awaiting the write is what orders it before the next request, since a
	 * provider that never declared the notification answers nothing to wait on.
	 */
	async notify(notification: ProviderNotification, params: unknown): Promise<void> {
		if (this.gone !== null) throw new Stall("exit", `provider process ${this.gone} before ${notification}`);
		await withTimeout(this.connection.sendNotification(notification, params), this.timeoutMs, notification);
	}

	/** Resolves once the process is gone, so a retry never overlaps it. */
	async close(): Promise<void> {
		this.connection.dispose();
		if (this.child.exitCode !== null || this.child.signalCode !== null) return;
		const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
		this.child.kill();
		// SIGTERM ignored; SIGKILL is not.
		const grace = setTimeout(() => this.child.kill("SIGKILL"), 2000);
		await exited;
		clearTimeout(grace);
	}
}

////////////////////////////////
//  Running

/** A fixture's discovery expectations against the files the provider listed. */
function discoveryProblems(fixture: ConformanceFixture, files: string[]): string[] {
	const problems: string[] = [];
	for (const [file, expected] of Object.entries(fixture.discovery ?? {})) {
		const listed = files.includes(file);
		if (listed !== expected) {
			problems.push(
				expected ? `discovery did not list ${file}` : `discovery listed ${file}, which is not claimed`,
			);
		}
	}
	return problems;
}

async function runCase(
	session: ProviderSession,
	testCase: ConformanceCase,
	fixture: ConformanceFixture,
	language: string,
	declaredRoles?: readonly string[],
	/** Required by `fileRoles` for code parses. */
	owesRole = false,
): Promise<string[]> {
	const problems: string[] = [];
	const text = fixture.files[fixture.subject];
	if (text === undefined) return [`subject ${fixture.subject} is not among the fixture's files`];

	// Derived by EXCLUSION, so the failure direction is a wasted parse rather than a silent pass.
	// Naming the expectations that need facts meant forgetting one made its cases run while
	// asserting nothing, which has happened here to six cases at once. Naming the fields that are
	// NOT expectations inverts it: a field nobody classifies simply costs one more parse.
	const stated = Object.keys({ ...testCase, ...fixture }).filter((key) => !CASE_METADATA.has(key));

	const expectedType = fixture.typeOf ?? testCase.typeOf;
	// One parse per case, since several checks want the same facts and a provider is free to answer
	// a second identical request differently once its own state has moved on.
	const parses = stated.length > 0;
	const facts = parses
		? await session.call("parseFile", { module: fixture.subject, contentHash: hashOf(text), text })
		: null;

	if (facts) {
		problems.push(...checkFacts(testCase, facts, language, text));
		if (owesRole && facts.role === undefined) problems.push("role: fileRoles is declared, but this parse has none");
		// A declared role list is a promise about coverage, so emitting outside it is the same
		// over-claim as declaring a tier that is not built. Undeclared coverage stays unchecked.
		if (declaredRoles !== undefined) {
			for (const role of new Set(facts.references.map((reference) => reference.role))) {
				if (!declaredRoles.includes(role)) {
					problems.push(`reference role ${role} is emitted but not declared at initialize`);
				}
			}
		}
	}

	if (facts && testCase.parseErrors) {
		const errors = facts.diagnostics.filter((diagnostic) => diagnostic.severity === "error");

		if (testCase.parseErrors === "required" && errors.length === 0) {
			problems.push("syntaxDiagnostics is declared but unparseable text produced no error diagnostic");
		}
		if (testCase.parseErrors === "forbidden" && errors.length > 0) {
			problems.push(`valid text produced ${errors.length} error diagnostic(s): ${errors[0]?.message}`);
		}
	}

	if (facts && testCase.notes) {
		const notes = facts.diagnostics.filter((diagnostic) => diagnostic.severity !== "error");
		if (testCase.notes === "required" && notes.length === 0) {
			problems.push("text worth a note produced no warning or info diagnostic");
		}
		if (testCase.notes === "forbidden" && notes.length > 0) {
			problems.push(`text produced ${notes.length} note(s) where none was expected: ${notes[0]?.message}`);
		}
	}

	// The fixture's own list wins when it has one, since a specifier is this language's syntax.
	for (const expected of fixture.imports ?? testCase.imports ?? []) {
		const resolution = await session.call("resolveImport", {
			fromModule: fixture.subject,
			specifier: expected.specifier,
		});
		problems.push(...checkImport(expected, resolution));
	}

	if (facts && expectedType) {
		const target = facts.declarations.find((d) => d.name === expectedType.name);
		if (!target) {
			problems.push(`type of ${expectedType.name}: the declaration was not reported`);
		} else {
			problems.push(...checkType(expectedType, await session.call("typeOf", { symbolId: target.symbolId })));
		}
	}

	return problems;
}

/**
 * A code provider's own vocabulary is not visible in facts, so it must state it: a highlighter has
 * nowhere else to learn a language's keywords. A data format ships none, honestly.
 */
function checkWordsDeclared(info: Pick<MethodResponse<"initialize">, "content" | "words">): CaseResult {
	const problems: string[] = [];
	const isDataFormat = info.content !== undefined && info.content !== "code";
	if (!isDataFormat && info.words.keywords.length === 0) {
		problems.push("a code provider announced no keywords at initialize");
	}
	return {
		caseId: "code-provider-declares-keywords",
		tier: "protocol",
		outcome: problems.length === 0 ? "passed" : "failed",
		problems,
	};
}

/** Bad request, never a diagnostic. */
async function checkBadModuleIsRefused(session: ProviderSession): Promise<CaseResult> {
	const problems: string[] = [];
	for (const module of ["../escaped.probe", "/absolute.probe"]) {
		try {
			await session.call("parseFile", { module, contentHash: "h0", text: "" });
			problems.push(`parseFile answered for ${JSON.stringify(module)}, which no symbol id can name`);
		} catch (error) {
			if (error instanceof Stall) throw error;
		}
	}
	return {
		caseId: "unrepresentable-module-is-refused",
		tier: "protocol",
		outcome: problems.length === 0 ? "passed" : "failed",
		problems,
	};
}

/**
 * Every provider answers moveEdits, and one that cannot move refuses rather than agreeing.
 *
 * Ungated by tier: a ready response with no edits and no blocked sites is indistinguishable from a
 * move that had nothing to do, so the core would relocate a declaration and leave every import
 * pointing at the old module.
 */
async function checkMoveIsAnswered(session: ProviderSession): Promise<CaseResult> {
	const problems: string[] = [];

	try {
		const answer = await session.call("moveEdits", {
			module: "src/probe-target",
			text: "",
			exists: false,
			symbolId: composeSymbolId({
				language: "probe",
				module: "src/probe-source",
				descriptors: [{ kind: "term", name: "probe" }],
			}),
			name: "probe",
			fromModule: "src/probe-source",
			toModule: "src/probe-target",
			role: {},
			importSites: [],
			dependencies: [],
			sites: [],
		});

		if (answer.status === "ready" && answer.edits.length === 0 && answer.blocked.length === 0) {
			problems.push("moveEdits answered ready with nothing to do, which reads as a move that succeeded");
		}
	} catch (error) {
		if (error instanceof Stall) throw error;
		problems.push(error instanceof Error ? error.message : String(error));
	}

	return {
		caseId: "moveEdits-is-answered",
		tier: "protocol",
		outcome: problems.length === 0 ? "passed" : "failed",
		problems,
	};
}

function checkReadyMove(fixture: MoveFixture, answer: MethodResponse<"moveEdits">): string[] {
	if (answer.status === "refused") {
		return [`moveEdits refused with ${answer.reason}, expected ready`];
	}
	if (answer.blocked.length > 0) {
		return [
			`moveEdits blocked with ${answer.blocked.map((site) => site.reason).join(", ")}, expected no blocked sites`,
		];
	}

	const applied = applyEdits(fixture.request.text, answer.edits);
	if ("problem" in applied) return [`could not apply move edits: ${applied.problem}`];

	const problems: string[] = [];
	if (fixture.expect.kind !== "ready") return ["internal move expectation mismatch"];
	for (const [module, expected] of Object.entries(fixture.expect.files)) {
		const actual = module === fixture.request.module ? applied.text : fixture.files[module];
		if (actual === undefined) {
			problems.push(`expected post-state names ${module}, which is not in the fixture`);
		} else if (actual !== expected) {
			problems.push(
				`post-state for ${module} was ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
			);
		}
	}
	return problems;
}

function checkBlockedMove(fixture: MoveFixture, answer: MethodResponse<"moveEdits">): string[] {
	if (answer.status === "refused") {
		return [`moveEdits refused with ${answer.reason}, expected blocked sites`];
	}
	if (answer.blocked.length === 0) return ["moveEdits had no blocked sites, expected at least one"];
	if (fixture.expect.kind !== "blocked" || fixture.expect.reasons === undefined) return [];

	const actual = new Set(answer.blocked.map((site) => site.reason));
	return fixture.expect.reasons
		.filter((reason) => !actual.has(reason))
		.map((reason) => `blocked reasons were ${[...actual].join(", ")}, expected ${reason}`);
}

function checkRefusedMove(fixture: MoveFixture, answer: MethodResponse<"moveEdits">): string[] {
	if (fixture.expect.kind !== "refused") return ["internal move expectation mismatch"];
	if (answer.status === "ready") return [`moveEdits answered ready, expected refusal ${fixture.expect.reason}`];
	return answer.reason === fixture.expect.reason
		? []
		: [`moveEdits refused with ${answer.reason}, expected ${fixture.expect.reason}`];
}

async function runMoveCase(session: ProviderSession, testCase: MoveCase, fixture: MoveFixture): Promise<CaseResult> {
	try {
		const answer = await session.call("moveEdits", fixture.request);
		if (answer.status === "refused" && answer.reason === "NotImplemented") {
			return {
				caseId: testCase.id,
				tier: "protocol",
				outcome: "skipped",
				problems: [
					`moveEdits refused with NotImplemented${answer.detail === undefined ? "" : `: ${answer.detail}`}`,
				],
			};
		}

		const problems =
			fixture.expect.kind === "ready"
				? checkReadyMove(fixture, answer)
				: fixture.expect.kind === "blocked"
					? checkBlockedMove(fixture, answer)
					: checkRefusedMove(fixture, answer);
		return {
			caseId: testCase.id,
			tier: "protocol",
			outcome: problems.length === 0 ? "passed" : "failed",
			problems,
		};
	} catch (error) {
		if (error instanceof Stall) throw error;
		return {
			caseId: testCase.id,
			tier: "protocol",
			outcome: "failed",
			problems: [error instanceof Error ? error.message : String(error)],
		};
	}
}

////////////////////////////////
//  Lifecycle

/** Which modules a use of `name` binds into. A specifier names a module, so import rows are out. */
function boundModules(facts: MethodResponse<"parseFile">, name: string): string[] {
	const found = new Set<string>();
	for (const reference of facts.references) {
		if (reference.name !== name || reference.role === "import" || reference.role === "export") continue;
		if (reference.binding.status !== "bound") continue;
		const module = moduleOf(reference.binding.symbolId);
		if (module !== null) found.add(module);
	}
	return [...found];
}

/** The control step first: a provider binding nothing across files must not pass while silent. */
async function runLifecycleCase(
	session: ProviderSession,
	testCase: LifecycleCase,
	fixture: LifecycleFixture,
): Promise<CaseResult> {
	const targetText = fixture.files[fixture.target] as string;
	const userText = fixture.files[fixture.user] as string;
	const problems: string[] = [];

	/** Parses the target and settles the index's verdict on it. */
	const settle = async (text: string, reason?: string): Promise<void> => {
		const contentHash = hashOf(text);
		await session.call("parseFile", { module: fixture.target, contentHash, text });
		const verdict: ModuleAdmission = {
			module: fixture.target,
			contentHash,
			outcome: reason === undefined ? { status: "admitted" } : { status: "refused", reason },
		};
		await session.notify("moduleAdmission", verdict);
	};

	/** Where the use lands now. */
	const uses = async (): Promise<string[]> => {
		const facts = await session.call("parseFile", {
			module: fixture.user,
			contentHash: hashOf(userText),
			text: userText,
		});
		return boundModules(facts, fixture.name);
	};

	await settle(targetText);
	if (!(await uses()).includes(fixture.target)) {
		return {
			caseId: testCase.id,
			tier: "binding",
			outcome: "skipped",
			problems: [
				`${fixture.user} does not bind ${fixture.name} into ${fixture.target}, so this provider holds no cross-file state for the case to correct`,
			],
		};
	}

	if (testCase.expect === "keepsAdmitted") {
		await settle(fixture.refusedText, "the index refused these facts");
		if (!(await uses()).includes(fixture.target)) {
			problems.push(
				`after a refused parse of ${fixture.target}, ${fixture.name} no longer binds into it: the refused facts replaced what the index still holds`,
			);
		}
		return { caseId: testCase.id, tier: "binding", outcome: problems.length === 0 ? "passed" : "failed", problems };
	}

	// The index holds nothing for the target: it let the module go, then refused the parse that
	// followed. A provider that kept the refused facts, or read them back off disk, binds anyway.
	//
	// The refused parse is the target's own text, so it DECLARES the name. Refusing text that
	// dropped the name would let a provider holding the refused facts pass, since the use would be
	// unbound either way.
	await session.notify("forgetModule", { module: fixture.target });
	await settle(targetText, "the index refused these facts");
	if ((await uses()).includes(fixture.target)) {
		problems.push(
			`${fixture.name} binds into ${fixture.target} after the index forgot it and refused the parse that followed, so the provider holds facts the index does not`,
		);
	}

	await settle(targetText);
	if (!(await uses()).includes(fixture.target)) {
		problems.push(
			`${fixture.name} no longer binds into ${fixture.target} after an admitted parse, so the refusal withheld it for good`,
		);
	}

	return { caseId: testCase.id, tier: "binding", outcome: problems.length === 0 ? "passed" : "failed", problems };
}

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
			await session.call("initialize", { workspaceRoot: root, protocolVersion: PROTOCOL_VERSION });
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
				await session.call("initialize", { workspaceRoot: root, protocolVersion: PROTOCOL_VERSION });
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

/**
 * A tier the provider CLAIMS and this run never actually asked it about.
 *
 * The suite skips a case with no fixture for the language, so a provider can declare a tier, be
 * asked nothing, and report a clean run. That is the tier system's own promise going unchecked.
 *
 * The two ways it happens are not the same fault. A tier the CORPUS has no cases for at all is the
 * corpus's gap and every provider shares it, so it reports rather than fails. A tier with cases that
 * this language has no fixture for is this provider's gap, and it fails.
 */
function untestedClaims(
	tiers: { [K in Tier]?: boolean | undefined },
	cases: ConformanceCase[],
	results: CaseResult[],
): CaseResult[] {
	const asked = new Set<string>(results.filter((r) => r.outcome !== "skipped").map((r) => r.tier));
	const offered = new Set<string>(cases.map((testCase) => testCase.tier));

	const found: CaseResult[] = [];
	for (const [name, claimed] of Object.entries(tiers)) {
		// `projectModel` has no cases and is proven by discovery, which every fixture already exercises.
		if (!claimed || asked.has(name) || name === "projectModel") continue;
		const corpusHasCases = offered.has(name);
		found.push({
			caseId: `claimed-tier-is-tested/${name}`,
			tier: name as Tier,
			outcome: corpusHasCases ? "failed" : "skipped",
			problems: [
				corpusHasCases
					? `${name} is declared but every case for it was skipped, so the claim went unchecked`
					: `${name} is declared and the corpus has no cases for it, which is the corpus's gap`,
			],
		});
	}
	return found;
}

/**
 * Runs every case against one provider.
 *
 * A case whose tier the provider does not declare is SKIPPED, not failed. That distinction is the
 * whole tiering claim: an honest partial provider has to be reportable as partial rather than as
 * broken, or nobody ships one.
 */
export async function runSuite(options: RunOptions): Promise<SuiteReport> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const startedAt = Date.now();
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-conformance-"));
	let session = ProviderSession.open(options.command, timeoutMs);

	try {
		// The live constant rather than a spelled version: a literal here silently stops matching
		// what the suite actually ships on the first bump.
		const hello = () => session.call("initialize", { workspaceRoot: root, protocolVersion: PROTOCOL_VERSION });
		let info: Awaited<ReturnType<typeof hello>>;
		try {
			info = await hello();
		} catch (first) {
			if (!(first instanceof Stall)) throw first;
			// One retry; none of five reproduced.
			await session.close();
			session = ProviderSession.open(options.command, timeoutMs);
			try {
				info = await hello();
			} catch (again) {
				if (!(again instanceof Stall)) throw again;
				const stall = new Stall(again.why, `initialize stalled twice: ${first.message}; then ${again.message}`);
				return unreached(stalled("initialize", "protocol", stall, startedAt, timeoutMs));
			}
		}
		const results: CaseResult[] = [];

		for (const testCase of options.cases) {
			const tier = testCase.tier as Tier;
			if (!info.tiers[tier]) {
				results.push({
					caseId: testCase.id,
					tier,
					outcome: "skipped",
					problems: [`tier ${tier} not declared`],
				});
				continue;
			}

			// A missing fixture is the corpus's gap, so it reads as a skip naming the language rather
			// than as this provider failing a case it was never given anything to answer.
			const fixture = testCase.fixtures[info.language];
			if (!fixture) {
				results.push({
					caseId: testCase.id,
					tier,
					outcome: "skipped",
					problems: [`no ${info.language} fixture`],
				});
				continue;
			}

			writeFixture(root, fixture.files);
			// Discovery before questions, because that is the order the core uses: it discovers a
			// project and then parses each module. Skipping it here tested providers in a state
			// nothing ever puts them in, and any provider that builds a project model during
			// discovery answered differently under conformance than in the real thing. Found when a
			// GDScript preload of a file plainly sitting in the fixture resolved as external.
			try {
				const project = await session.call("discoverProject", { workspaceRoot: root });
				const problems = [
					...discoveryProblems(fixture, project.files),
					...(await runCase(
						session,
						testCase,
						fixture,
						info.language,
						info.referenceRoles,
						info.tiers.fileRoles === true && (info.content ?? "code") === "code",
					)),
				];
				results.push({
					caseId: testCase.id,
					tier,
					outcome: problems.length === 0 ? "passed" : "failed",
					problems,
				});
			} catch (error) {
				// A thrown request is this case's failure, never the suite's: the remaining cases
				// still carry information about what the provider does get right.
				if (error instanceof Stall) {
					results.push(stalled(testCase.id, tier, error, startedAt, timeoutMs));
					continue;
				}
				const message = error instanceof Error ? error.message : String(error);
				results.push({ caseId: testCase.id, tier, outcome: "failed", problems: [message] });
			}
		}

		for (const [index, testCase] of (options.moveCases ?? []).entries()) {
			const fixture = testCase.fixtures[info.language];
			if (!fixture) {
				results.push({
					caseId: testCase.id,
					tier: "protocol",
					outcome: "skipped",
					problems: [`no ${info.language} fixture`],
				});
				continue;
			}

			// Each move gets a clean project because its file graph controls specifier rendering.
			const moveRoot = path.join(root, `move-${index}`);
			writeFixture(moveRoot, fixture.files);
			try {
				await session.call("initialize", { workspaceRoot: moveRoot, protocolVersion: PROTOCOL_VERSION });
				await session.call("discoverProject", { workspaceRoot: moveRoot });
				results.push(await runMoveCase(session, testCase, fixture));
			} catch (error) {
				if (error instanceof Stall) {
					results.push(stalled(testCase.id, "protocol", error, startedAt, timeoutMs));
					continue;
				}
				results.push({
					caseId: testCase.id,
					tier: "protocol",
					outcome: "failed",
					problems: [error instanceof Error ? error.message : String(error)],
				});
			}
		}

		for (const testCase of options.lifecycleCases ?? []) {
			const fixture = testCase.fixtures[info.language];
			if (!info.tiers.binding || !fixture) {
				results.push({
					caseId: testCase.id,
					tier: "binding",
					outcome: "skipped",
					problems: [info.tiers.binding ? `no ${info.language} fixture` : "tier binding not declared"],
				});
				continue;
			}

			// Its own project, because the case rewrites the target and asks where a use lands.
			const lifecycleRoot = path.join(root, `lifecycle-${testCase.id}`);
			writeFixture(lifecycleRoot, fixture.files);
			try {
				if (testCase.expect === "unseen") {
					results.push(await runUnseenCase(options.command, timeoutMs, lifecycleRoot, testCase, fixture));
					continue;
				}
				await session.call("initialize", { workspaceRoot: lifecycleRoot, protocolVersion: PROTOCOL_VERSION });
				await session.call("discoverProject", { workspaceRoot: lifecycleRoot });
				results.push(await runLifecycleCase(session, testCase, fixture));
			} catch (error) {
				if (error instanceof Stall) {
					results.push(stalled(testCase.id, "binding", error, startedAt, timeoutMs));
					continue;
				}
				results.push({
					caseId: testCase.id,
					tier: "binding",
					outcome: "failed",
					problems: [error instanceof Error ? error.message : String(error)],
				});
			}
		}

		// Pure, so it runs even when the session died answering an earlier case.
		results.push(checkWordsDeclared(info));

		// Last, so the provider has been through discovery. A provider that really moves needs its
		// project model, and probing it cold would test a state nothing else puts it in.
		try {
			results.push(await checkMoveIsAnswered(session));
			results.push(await checkBadModuleIsRefused(session));
		} catch (error) {
			if (!(error instanceof Stall)) throw error;
			results.push(stalled("protocol-probes", "protocol", error, startedAt, timeoutMs));
		}

		results.push(...untestedClaims(info.tiers, options.cases, results));

		return {
			providerId: info.providerId,
			language: info.language,
			tiers: info.tiers,
			results,
			...counts(results),
		};
	} finally {
		await session.close();
		rmSync(root, { recursive: true, force: true });
	}
}

function counts(results: CaseResult[]): Pick<SuiteReport, "passed" | "failed" | "skipped" | "stalled"> {
	const of = (outcome: CaseOutcome) => results.filter((r) => r.outcome === outcome).length;
	return { passed: of("passed"), failed: of("failed"), skipped: of("skipped"), stalled: of("stalled") };
}

/** Never answered; nothing known. */
function unreached(result: CaseResult): SuiteReport {
	const tiers = Object.fromEntries(TierSchema.options.map((tier) => [tier, false])) as ProviderTiers;
	return { providerId: "unknown", language: "unknown", tiers, results: [result], ...counts([result]) };
}

const MARKS: Record<CaseOutcome, string> = { passed: "PASS", failed: "FAIL", skipped: "SKIP", stalled: "STALL" };

/** One line per case, plus a tail naming what was skipped and why. */
export function formatReport(report: SuiteReport): string {
	const lines = [`${report.providerId} (${report.language})`];
	for (const result of report.results) {
		lines.push(`  ${MARKS[result.outcome]}  ${result.tier}/${result.caseId}`);
		for (const problem of result.problems) lines.push(`          ${problem}`);
	}
	lines.push(`${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped`);
	if (report.stalled > 0) {
		lines.push(
			`${report.stalled} stalled: a timeout or a dead process, which is the machine or the run, not an answer`,
		);
	}
	return lines.join("\n");
}
