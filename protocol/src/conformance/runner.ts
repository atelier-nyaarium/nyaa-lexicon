// Runs the corpus against a provider process. Depends on the protocol alone, never on the core, so
// a provider team can prove its own work without waiting for anything else to exist.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import path from "node:path";
import { PROTOCOL_VERSION } from "../version.js";
import { checkFacts, checkImport, checkProbeBatch, checkType } from "./check.js";
import { discoveryProblems, runCase } from "./factCases.js";
import { runLifecycleCase } from "./lifecycleCases.js";
import {
	checkArrangeIsAnswered,
	checkBadModuleIsRefused,
	checkImportIsAnswered,
	checkMoveIsAnswered,
	checkWordsDeclared,
} from "./methodCases.js";
import { runMoveCase } from "./moveCases.js";
import { CONFORMANCE_POLICY } from "./policy.js";
import { runProbeBatchCase as runProbeBatchCaseWithChecker } from "./probeCases.js";
import { ProviderSession, Stall } from "./providerSession.js";
import { counts, unreached } from "./report.js";
import type {
	CaseResult,
	ConformanceCase,
	LifecycleCase,
	MoveCase,
	ProbeBatchCase,
	ProbeBatchFixture,
	SuiteReport,
	Tier,
} from "./types.js";
import { runUnseenCase } from "./unseenCases.js";

export { CASE_METADATA } from "./caseSupport.js";
export { formatReport } from "./report.js";

////////////////////////////////
//  Interfaces & Types

export interface RunOptions {
	/** Argv of the provider process, e.g. ["bun", "run", "providers/typescript/src/main.ts"]. */
	command: string[];
	cases: ConformanceCase[];
	moveCases?: MoveCase[];
	lifecycleCases?: LifecycleCase[];
	probeBatchCases?: ProbeBatchCase[];
	/** Milliseconds any single request may take before the case is failed. */
	timeoutMs?: number;
}

////////////////////////////////
//  Constants

const DEFAULT_TIMEOUT_MS = 10_000;

////////////////////////////////
//  Functions & Helpers

function writeFixture(root: string, files: Record<string, string>): void {
	for (const [relative, contents] of Object.entries(files)) {
		const full = path.join(root, relative);
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, contents);
	}
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

async function runProbeBatchCase(
	session: ProviderSession,
	testCase: ProbeBatchCase,
	fixture: ProbeBatchFixture,
): Promise<CaseResult> {
	return runProbeBatchCaseWithChecker(session, testCase, fixture, checkProbeBatch);
}

/**
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
	language: string,
): CaseResult[] {
	const asked = new Set<string>(results.filter((r) => r.outcome !== "skipped").map((r) => r.tier));
	const offered = new Set<string>(cases.map((testCase) => testCase.tier));

	const found: CaseResult[] = [];
	for (const [name, claimed] of Object.entries(tiers)) {
		// `projectModel` has no cases and is proven by discovery, which every fixture already exercises.
		if (!claimed || asked.has(name) || name === "projectModel" || name === "fileRoles") continue;
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
	if (
		tiers.fileRoles === true &&
		!cases.some((testCase) => testCase.tier === "fileRoles" && testCase.applicableLanguages?.includes(language))
	) {
		found.push({
			caseId: `claimed-tier-has-no-role-forms/${language}`,
			tier: "fileRoles",
			outcome: "failed",
			problems: [`fileRoles is declared for ${language}, but no role form applies to that language`],
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
		const hello = () =>
			session.call("initialize", {
				workspaceRoot: root,
				protocolVersion: PROTOCOL_VERSION,
				policy: CONFORMANCE_POLICY,
			});
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

		for (const [index, testCase] of options.cases.entries()) {
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
			const formed = tier === "fileRoles" && testCase.semanticForm !== undefined;
			if (formed && !testCase.applicableLanguages?.includes(info.language)) {
				results.push({
					caseId: testCase.id,
					tier,
					outcome: "skipped",
					problems: [`${testCase.semanticForm} is not applicable to ${info.language}`],
				});
				continue;
			}

			const fixture = testCase.fixtures[info.language];
			if (!fixture) {
				// Applicable forms need fixtures.
				results.push({
					caseId: testCase.id,
					tier,
					outcome: formed ? "failed" : "skipped",
					problems: [`no ${info.language} fixture`],
				});
				continue;
			}

			// Its own project, so a workspace-wide lookup never meets an earlier case's files.
			const caseRoot = path.join(root, `case-${index}`);
			writeFixture(caseRoot, fixture.files);
			// Discovery before questions, the order core uses, so a model built at discovery is present.
			try {
				await session.call("initialize", {
					workspaceRoot: caseRoot,
					protocolVersion: PROTOCOL_VERSION,
					policy: CONFORMANCE_POLICY,
				});
				const project = await session.call("discoverProject", { workspaceRoot: caseRoot });
				const problems = [
					...discoveryProblems(fixture, project.files),
					...(await runCase(
						session,
						testCase,
						fixture,
						info.language,
						{ checkFacts, checkImport, checkType },
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
				await session.call("initialize", {
					workspaceRoot: moveRoot,
					protocolVersion: PROTOCOL_VERSION,
					policy: CONFORMANCE_POLICY,
				});
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
				await session.call("initialize", {
					workspaceRoot: lifecycleRoot,
					protocolVersion: PROTOCOL_VERSION,
					policy: CONFORMANCE_POLICY,
				});
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

		for (const testCase of options.probeBatchCases ?? []) {
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

			// Its own project: the probe proposes texts over files on disk.
			const probeRoot = path.join(root, `probe-${testCase.id}`);
			writeFixture(probeRoot, fixture.files);
			try {
				await session.call("initialize", {
					workspaceRoot: probeRoot,
					protocolVersion: PROTOCOL_VERSION,
					policy: CONFORMANCE_POLICY,
				});
				await session.call("discoverProject", { workspaceRoot: probeRoot });
				results.push(await runProbeBatchCase(session, testCase, fixture));
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

		// Pure, so it runs even when the session died answering an earlier case.
		results.push(checkWordsDeclared(info));

		// Last, so the provider has been through discovery. A provider that really moves needs its
		// project model, and probing it cold would test a state nothing else puts it in.
		try {
			results.push(await checkMoveIsAnswered(session));
			results.push(await checkArrangeIsAnswered(session));
			results.push(await checkImportIsAnswered(session));
			results.push(await checkBadModuleIsRefused(session));
		} catch (error) {
			if (!(error instanceof Stall)) throw error;
			results.push(stalled("protocol-probes", "protocol", error, startedAt, timeoutMs));
		}

		results.push(...untestedClaims(info.tiers, options.cases, results, info.language));

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
