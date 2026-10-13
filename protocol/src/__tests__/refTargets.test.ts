import { describe, expect, it } from "bun:test";
import { buildRef, formatRefTarget, parseRefTarget, refSelection, selectionWithin } from "../refTargets";

const project = "proj-0123456789abcdef";

describe("ref targets", () => {
	it("builds and parses project refs with inclusive lines", () => {
		const built = buildRef({
			project,
			module: "src/a b.ts",
			segments: ["Cart:Part"],
			lines: { start: 95, end: 89 },
		});
		expect(built.ok).toBe(true);
		if (!built.ok) return;
		expect(built.target).toEqual({
			project,
			module: "src/a b.ts",
			segments: ["Cart:Part"],
			lines: { start: 89, end: 95 },
		});
		expect(parseRefTarget(built.ref)).toEqual({ ok: true, target: built.target });
	});

	it("preserves UTF-16 columns and exclusive range ends", () => {
		const parsed = parseRefTarget(`project-ref://${project}/src/a.ts#L1,3-L2,4`);
		expect(parsed).toEqual({
			ok: true,
			target: {
				project,
				module: "src/a.ts",
				segments: [],
				range: { start: { line: 0, character: 2 }, end: { line: 1, character: 3 } },
			},
		});
		if (!parsed.ok) return;
		expect(refSelection(parsed.target, "😀x\r\nabc")).toEqual({
			ok: true,
			range: { start: { line: 0, character: 2 }, end: { line: 1, character: 3 } },
		});
	});

	it("round trips supported line and position coordinates", () => {
		const expected = [
			[
				`project-ref://${project}/src/a.ts#L95-L89`,
				{ start: { line: 88, character: 0 }, end: { line: 94, character: 0 } },
			],
			[
				`project-ref://${project}/src/a.ts#L4,9-L2,2`,
				{ start: { line: 1, character: 1 }, end: { line: 3, character: 8 } },
			],
			[
				`project-ref://${project}/src/a.ts#L89,8-L92`,
				{ start: { line: 88, character: 7 }, end: { line: 91, character: 0 } },
			],
			[
				`project-ref://${project}/src/a.ts#L89-L92,20`,
				{ start: { line: 88, character: 0 }, end: { line: 91, character: 19 } },
			],
			[`project-ref://${project}/src/a.ts#89..95`, { lines: { start: 89, end: 95 } }],
			[
				`project-ref://${project}/src/a.ts#L89-L95`,
				{ start: { line: 88, character: 0 }, end: { line: 94, character: 0 } },
			],
			[
				`project-ref://${project}/src/a.ts#L89`,
				{ start: { line: 88, character: 0 }, end: { line: 88, character: 0 } },
			],
		] as const;
		for (const [uri, selection] of expected) {
			const parsed = parseRefTarget(uri);
			expect(parsed.ok, uri).toBe(true);
			if (!parsed.ok) continue;
			expect(
				JSON.stringify(
					parsed.target.range
						? { start: parsed.target.range.start, end: parsed.target.range.end }
						: { lines: parsed.target.lines },
				),
			).toBe(JSON.stringify("lines" in selection ? selection : { start: selection.start, end: selection.end }));
		}
	});

	it("maps line selections across CRLF and EOF, and caret columns use UTF-16", () => {
		const lines = parseRefTarget(`project-ref://${project}/src/a.ts#2..3`);
		expect(lines.ok).toBe(true);
		if (lines.ok)
			expect(refSelection(lines.target, "😀x\r\nabc\r\nlast")).toEqual({
				ok: true,
				range: { start: { line: 1, character: 0 }, end: { line: 2, character: 4 } },
			});
		const caret = parseRefTarget(`project-ref://${project}/src/a.ts#L1,3`);
		expect(caret.ok).toBe(true);
		if (caret.ok)
			expect(refSelection(caret.target, "😀x")).toEqual({
				ok: true,
				range: { start: { line: 0, character: 2 }, end: { line: 0, character: 2 } },
			});
	});

	it("requires a project ID and rejects malformed selections", () => {
		expect(buildRef({ module: "src/a.ts" }).ok).toBe(false);
		expect(buildRef({ project: "../other", module: "src/a.ts" }).ok).toBe(false);
		for (const uri of [
			"project-ref:///src/a.ts",
			`project-ref://${project}/src/a.ts#`,
			`project-ref://${project}/src/a.ts#1..x`,
			`project-ref://${project}/src/a.ts#L0,2`,
			`project-ref://${project}/src/a.ts#L9007199254740992,1`,
			`project-ref://${project}/src/a.ts#1-4garbage`,
		])
			expect(parseRefTarget(uri).ok, uri).toBe(false);
		expect(buildRef({ project, module: "../outside" }).ok).toBe(false);
		expect(buildRef({ project, module: "src/\ud800.ts" }).ok).toBe(false);
		expect(
			buildRef({
				project,
				module: "src/a.ts",
				lines: { start: 1, end: 2 },
				range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
			}).ok,
		).toBe(false);
		const outside = parseRefTarget(`project-ref://${project}/src/a.ts#L4,2`);
		if (outside.ok) expect(refSelection(outside.target, "abc").ok).toBe(false);
	});

	it("builds refs for workspace keys with safe punctuation prefixes", () => {
		for (const project of ["_repo-a131a75117bed1fa", ".repo-f48fe9db3f84173b", "-repo-9a9f3a86b1258638"]) {
			const built = buildRef({ project, module: "src/a.ts" });
			expect(built.ok).toBe(true);
			if (built.ok) expect(parseRefTarget(built.ref)).toMatchObject({ ok: true, target: { project } });
		}
	});

	it("formats canonical coordinates and checks declaration bounds", () => {
		const target = {
			project,
			module: "src/a.ts",
			segments: ["A"],
			range: { start: { line: 0, character: 0 }, end: { line: 1, character: 3 } },
		};
		expect(formatRefTarget(target)).toBe(`project-ref://${project}/src/a.ts:A#L1,1-L2,4`);
		expect(selectionWithin(target, { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } })).toBe(
			true,
		);
		expect(selectionWithin(target, { start: { line: 0, character: 1 }, end: { line: 1, character: 3 } })).toBe(
			false,
		);
		expect(
			selectionWithin(
				{ project, module: "src/a.ts", segments: ["A"] },
				{ start: { line: 0, character: 0 }, end: { line: 2, character: 0 } },
			),
		).toBe(true);
	});
});
