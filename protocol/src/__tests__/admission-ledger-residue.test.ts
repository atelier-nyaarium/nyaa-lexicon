import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { declaresName, parseSource } from "../astResidue";
import { codeOnly, readSwept, sourceFiles } from "../residue";

/**
 * `forgetModule` says the index holds nothing, `moduleAdmission` says it holds the previous facts.
 * A provider answering one still disagrees with the index on the other.
 */
const PROVIDERS = join(import.meta.dirname, "..", "..", "..", "providers");

const LEDGER = "AdmissionLedger";

const SKIP_DIRS = new Set(["dist", "node_modules", ".tsbuild", "__tests__"]);

/** A notification handled, as a method of the provider object. */
const handles = (source: string, notification: string) => new RegExp(`\\b${notification}\\s*\\(`).test(source);

function providerDirectories(): string[] {
	return readdirSync(PROVIDERS, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);
}

/** Every provider's sources, by provider, with comments stripped. */
function swept(): Array<{ provider: string; code: string; files: string[] }> {
	const read: Array<{ provider: string; code: string; files: string[] }> = [];
	for (const provider of providerDirectories()) {
		const files = sourceFiles(join(PROVIDERS, provider, "src"), SKIP_DIRS);
		const texts = files.map((file) => readSwept(file)).filter((text): text is string => text !== null);
		if (texts.length === 0) continue;
		read.push({ provider, code: texts.map(codeOnly).join("\n"), files });
	}
	return read;
}

////////////////////////////////
//  Tests

describe("every stateful provider corrects through one primitive", () => {
	it("reads every provider's sources, so a passing run is never vacuous", () => {
		const read = swept();
		expect(read.map((entry) => entry.provider).sort()).toEqual(providerDirectories().sort());
		expect(read.filter((entry) => entry.code.includes(LEDGER)).length).toBeGreaterThanOrEqual(9);
	});

	it("has every provider declare its admission, a ledger or null", () => {
		const offenders = swept()
			.filter((entry) => !/readonly admission\s*=\s*(null|new AdmissionLedger)/.test(entry.code))
			.map((entry) => entry.provider);

		expect(
			offenders,
			"declare `readonly admission = new AdmissionLedger(...)`, or `= null` when nothing is held",
		).toEqual([]);
	});

	it("leaves staging, settling and probing to the kit", () => {
		const offenders = swept()
			.filter(
				(entry) => /\.(staged|settle|probe)\s*\(/.test(entry.code) || handles(entry.code, "moduleAdmission"),
			)
			.map((entry) => entry.provider);

		expect(offenders, "handlersFor stages each parse, settles each verdict and derives probeFile").toEqual([]);
	});

	it("has every stateful provider answer forgetModule", () => {
		const offenders = swept()
			.filter((entry) => entry.code.includes(`new ${LEDGER}`) && !handles(entry.code, "forgetModule"))
			.map((entry) => entry.provider);

		expect(offenders, "forgetModule says the index holds nothing; drop the module and call forgotten").toEqual([]);
	});

	it("has a probe test for every stateful provider", () => {
		const offenders = swept()
			.filter((entry) => entry.code.includes(`new ${LEDGER}`))
			.filter((entry) => {
				const tests = sourceFiles(join(PROVIDERS, entry.provider, "src", "__tests__"), new Set());
				return !tests.some((file) => readSwept(file)?.includes("probeFile") === true);
			})
			.map((entry) => entry.provider);

		expect(offenders, "a snapshot can leave state out; a probe test is the guard").toEqual([]);
	});

	it("has no provider declaring a ledger of its own", () => {
		const offenders: string[] = [];
		for (const entry of swept()) {
			for (const file of entry.files) {
				const text = readSwept(file);
				if (text === null) continue;
				if (declaresName(parseSource(file, text).source, LEDGER)) offenders.push(`${entry.provider}: ${file}`);
			}
		}

		expect(offenders, "AdmissionLedger belongs to protocol/src/admission.ts").toEqual([]);
	});
});
