// Runs the corpus against a provider process. Depends on the protocol alone, never on the core, so
// a provider team can prove its own work without waiting for anything else to exist.

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import path from "node:path";
import { createMessageConnection, ErrorCodes, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import type { z } from "zod";
import { applyEdits } from "../edits.js";
import { METHOD_SCHEMAS, type ProviderMethod, type ProviderTiers } from "../methods.js";
import { composeSymbolId } from "../symbolId.js";
import { PROTOCOL_VERSION } from "../version.js";
import { checkFacts, checkImport, checkType } from "./check.js";
import {
	type CaseOutcome,
	type CaseResult,
	type ConformanceCase,
	type ConformanceFixtureSchema,
	type MoveCase,
	type MoveFixture,
	type SuiteReport,
	type Tier,
	TierSchema,
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
	/** Milliseconds any single request may take before the case is failed. */
	timeoutMs?: number;
}

////////////////////////////////
//  Constants

const DEFAULT_TIMEOUT_MS = 10_000;

/** Case and fixture fields that state no expectation. Everything else earns a parse. */
const CASE_METADATA = new Set(["id", "tier", "about", "fixtures", "files", "subject"]);

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
	return Promise.race([
		work,
		new Promise<T>((_, reject) =>
			setTimeout(() => reject(new Stall("timeout", `${what} timed out after ${ms}ms`)), ms),
		),
	]);
}

/** Busy machine or broken provider. */
function environment(startedAt: number): string {
	const [load] = loadavg();
	return `load ${(load ?? 0).toFixed(2)} on ${cpus().length} cpus, ${Math.round((Date.now() - startedAt) / 1000)}s into the run`;
}

function stalled(caseId: string, tier: Tier | "protocol", stall: Stall, startedAt: number): CaseResult {
	return { caseId, tier, outcome: "stalled", problems: [`${stall.message} (${environment(startedAt)})`] };
}

////////////////////////////////
//  Class

/** Owns the child process and the connection, so a caller sees requests and not a transport. */
class ProviderSession {
	/** Set at death. */
	private gone: string | null = null;
	/** Rejects at death. */
	private readonly dead: Promise<never>;

	private constructor(
		private readonly child: ChildProcess,
		private readonly connection: ReturnType<typeof createMessageConnection>,
		private readonly timeoutMs: number,
	) {
		this.dead = new Promise<never>((_, reject) => {
			const die = (how: string) => {
				this.gone ??= how;
				reject(new Stall("exit", `provider process ${how}`));
			};
			child.once("exit", (code, signal) => die(`exited (${signal === null ? `code ${code}` : signal})`));
			child.once("error", (error) => die(`failed to start (${error.message})`));
			connection.onClose(() => die("closed its connection"));
		});
		// Awaited only inside a race.
		this.dead.catch(() => {});
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
			const answer = Promise.race([this.connection.sendRequest(method, params), this.dead]);
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

async function runCase(
	session: ProviderSession,
	testCase: ConformanceCase,
	fixture: ConformanceFixture,
	language: string,
	declaredRoles?: readonly string[],
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
				return unreached(stalled("initialize", "protocol", stall, startedAt));
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
				await session.call("discoverProject", { workspaceRoot: root });
				const problems = await runCase(session, testCase, fixture, info.language, info.referenceRoles);
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
					results.push(stalled(testCase.id, tier, error, startedAt));
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
					results.push(stalled(testCase.id, "protocol", error, startedAt));
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

		// Last, so the provider has been through discovery. A provider that really moves needs its
		// project model, and probing it cold would test a state nothing else puts it in.
		try {
			results.push(await checkMoveIsAnswered(session));
		} catch (error) {
			if (!(error instanceof Stall)) throw error;
			results.push(stalled("move-is-answered", "protocol", error, startedAt));
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
