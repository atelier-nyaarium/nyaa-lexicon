import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { callsTo, constructionsOf, memberReads, nodesIn, parseSource, stringsIn } from "@nyaa-lexicon/protocol/ast";
import ts from "typescript";

/** Holds clock.ts as the only source of time in core, so one fake controls a whole daemon. */
const SRC = join(import.meta.dirname, "..");

/** The one owner. */
const OWNER = "clock.ts";

const member = (receiver: string, name: string) => (root: ts.Node) =>
	memberReads(root).some((read) => read.receiver === receiver && read.name === name);

const call = (name: string, receiver?: string) => (root: ts.Node) => callsTo(root, name, receiver).length > 0;

/** Reaching for the wall or the host timers directly. */
const RAW: Array<[string, (root: ts.Node) => boolean]> = [
	["Date.now", member("Date", "now")],
	[
		"Date[...]",
		(root) =>
			nodesIn(root).some(
				(node) =>
					ts.isElementAccessExpression(node) &&
					ts.isIdentifier(node.expression) &&
					node.expression.text === "Date",
			),
	],
	["new Date()", (root) => constructionsOf(root, "Date").some((node) => (node.arguments?.length ?? 0) === 0)],
	["performance.now()", call("now", "performance")],
	["process.hrtime", member("process", "hrtime")],
	["setTimeout()", call("setTimeout")],
	["clearTimeout()", call("clearTimeout")],
	["setInterval()", call("setInterval")],
	["clearInterval()", call("clearInterval")],
	["setImmediate()", call("setImmediate")],
	["Bun.sleep()", call("sleep", "Bun")],
	["Bun.nanoseconds()", call("nanoseconds", "Bun")],
	["node:timers", (root) => stringsIn(root).some(({ text }) => text.startsWith("node:timers"))],
];

function reachesFor(name: string): string[] {
	const { source } = parseSource(name, readFileSync(join(SRC, name), "utf8"));
	return RAW.filter(([, reaches]) => reaches(source)).map(([spelling]) => spelling);
}

/** Every production module of core: the top-level sources, tests and the owner aside. */
function swept(): string[] {
	return readdirSync(SRC, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && entry.name !== OWNER)
		.map((entry) => entry.name)
		.sort();
}

////////////////////////////////
//  Tests

describe("one clock for core", () => {
	it("keeps the owner on the raw primitives, so a passing sweep is never vacuous", () => {
		expect(reachesFor(OWNER).length).toBeGreaterThan(2);
	});

	it("has no module reaching past the clock", () => {
		const modules = swept();
		expect(modules.length).toBeGreaterThan(20);
		expect(modules).toContain("notes.ts");
		expect(modules).toContain("daemonCli.ts");

		const offenders = modules.flatMap((name) => reachesFor(name).map((spelling) => `${name}: ${spelling}`));

		expect(offenders, "time in core comes from the Clock in core/src/clock.ts, injected or systemClock").toEqual(
			[],
		);
	});
});
