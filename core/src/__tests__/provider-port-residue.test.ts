import { describe, expect, it } from "bun:test";
import { basename } from "node:path";
import { sourceFiles } from "@nyaa-lexicon/protocol";
import { nodesIn, parsedFiles } from "@nyaa-lexicon/protocol/ast";
import ts from "typescript";

////////////////////////////////
//  Interfaces & Types

/**
 * Holds every test double of the provider set to the port's type.
 *
 * Bug class killed: a fake cast to the class, so a member core starts calling breaks a suite at
 * runtime instead of failing the type check.
 */
const TESTS = import.meta.dirname;

const FORBIDDEN = "ProviderSupervisor";

/** `x as ProviderSupervisor` or `<ProviderSupervisor>x`. */
function casts(root: ts.Node): boolean {
	return nodesIn(root).some(
		(node) =>
			(ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
			ts.isTypeReferenceNode(node.type) &&
			ts.isIdentifier(node.type.typeName) &&
			node.type.typeName.text === FORBIDDEN,
	);
}

/** By path, so a same-named file in a subdirectory is still swept. */
const SELF = import.meta.filename;

/** The shared double every converted suite now builds through; its absence means the sweep found nothing real. */
const WITNESS = "fakeProvider.ts";

////////////////////////////////
//  Tests

describe("no test casts a fake to the supervisor class", () => {
	it("sweeps the tests it is written for, so a passing run is never vacuous", () => {
		expect(sourceFiles(TESTS, []).map((file) => basename(file))).toContain(WITNESS);
	});

	it("names the cast nowhere under the tests", () => {
		const offenders = parsedFiles(TESTS, [])
			.filter(({ file, source }) => file !== SELF && casts(source))
			.map(({ file }) => basename(file));

		expect(
			offenders,
			"build the double with fakeSupervisor from fakeProvider.ts, or type it as the ProviderPort it implements",
		).toEqual([]);
	});
});
