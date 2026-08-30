import { describe, expect, it } from "bun:test";
import type { MethodRequest } from "../providerPort";
import { FAKE_CLAIMS, fakeSupervisor, parseFake, resolveFake } from "./fakeProvider";

const REQUEST = { module: "a.fake", contentHash: "h", text: "export class X {}" };

////////////////////////////////
//  Tests

describe("the fake provider's defaults", () => {
	it("declares exported classes with their body span, reads imports, and fails a SYNTAX line", () => {
		const facts = parseFake({
			module: "a.fake",
			contentHash: "h",
			text: 'import "./b"\nexport class Cart {\n}\nSYNTAX\n',
		});

		expect(facts.declarations.map((d) => [d.symbolId, d.range.end.line])).toEqual([
			["lexicon fake a.fake Cart#", 2],
		]);
		expect(facts.imports.map((i) => i.specifier)).toEqual(["./b"]);
		expect(facts.diagnostics).toEqual([{ severity: "error", message: "syntax error" }]);
		expect("depth" in parseFake({ module: "a.fake", contentHash: "h", text: "", depth: "outline" })).toBe(true);
	});

	it("resolves a relative specifier against its importer and nothing else", () => {
		expect(resolveFake({ fromModule: "src/a.fake", specifier: "./b" })).toEqual({
			status: "resolved",
			module: "src/b",
		});
		expect(resolveFake({ fromModule: "src/a.fake", specifier: "pkg" })).toMatchObject({ status: "unresolved" });
	});
});

describe("the fake provider set", () => {
	it("routes by its claims, answers the defaults, discovers what it is told, and declares only the tiers given", async () => {
		const set = fakeSupervisor({ discover: () => ["a.fake"], tiers: { comments: true } });

		expect(set.running()).toEqual([FAKE_CLAIMS]);
		expect(set.route("a.fake")).toMatchObject({ owned: true, providerId: "fake" });
		expect(set.route("a.other")).toMatchObject({ owned: false });
		expect(await set.askProvider("fake", "discoverProject", {})).toMatchObject({ files: ["a.fake"] });
		const parsed = await set.ask("a.fake", "parseFile", {
			module: "a.fake",
			contentHash: "h",
			text: "export class X {}",
		});
		expect(parsed.declarations).toHaveLength(1);
		expect(set.declares("fake", "comments")).toBe(true);
		expect(set.declares("fake", "references")).toBe(false);
	});

	it("refuses an ask for a module nobody owns, and one two providers claim, the way the daemon does", async () => {
		const contested = fakeSupervisor({
			claims: [
				{ providerId: "one", language: "one", extensions: [".x"] },
				{ providerId: "two", language: "two", extensions: [".x"] },
			],
		});

		await expect(fakeSupervisor().ask("a.other", "parseFile", {})).rejects.toThrow("no provider owns a.other");
		await expect(contested.ask("a.x", "parseFile", {})).rejects.toThrow("claimed by one, two");
		await expect(fakeSupervisor().askProvider("ghost", "discoverProject", {})).rejects.toThrow("is not running");
	});

	it("keeps a parse answer's comments only where the tiers declare them", async () => {
		const commented = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, text: "hi" };
		const answers = {
			parseFile: (request: MethodRequest<"parseFile">) => ({ ...parseFake(request), comments: [commented] }),
		};

		const undeclared = await fakeSupervisor({ answers }).ask("a.fake", "parseFile", REQUEST);
		const declared = await fakeSupervisor({ answers, tiers: { comments: true } }).ask(
			"a.fake",
			"parseFile",
			REQUEST,
		);

		expect(undeclared.comments).toBeUndefined();
		expect(declared.comments).toEqual([commented]);
	});

	it("refuses an answer the wire would refuse", async () => {
		const set = fakeSupervisor({ answers: { resolveImport: () => ({ status: "resolved" }) as never } });

		await expect(set.ask("a.fake", "resolveImport", { fromModule: "a.fake", specifier: "./b" })).rejects.toThrow();
	});

	it("lets an answer override a default and throws for a method nothing answers", async () => {
		const set = fakeSupervisor({
			answers: { resolveImport: (request) => ({ status: "resolved", module: `${request.specifier}.fake` }) },
		});

		expect(await set.ask("a.fake", "resolveImport", { fromModule: "a.fake", specifier: "x" })).toEqual({
			status: "resolved",
			module: "x.fake",
		});
		await expect(set.ask("a.fake", "bind", {})).rejects.toThrow("unexpected method bind");
	});
});
