import { describe, expect, it } from "bun:test";
import { blankCode, findRefLinks, findRefs, formatRef, parseRef } from "../noteRefs";
import { NOTE_MAX } from "../noteShapes";

const project = "proj-0123456789abcdef";
const ref = (module: string) => `project-ref://${project}/${module}`;

describe("note refs", () => {
	it("finds Markdown links, including angle destinations, and skips code", () => {
		const text =
			`[Cart](${ref("src/cart.ts")}) [add](<${ref("src/a b.ts:add")}>)\n${ref("bare.ts")} \`${ref("inline.ts")}\`\n\n` +
			"```ts\n[hidden](" +
			ref("hidden.ts") +
			")\n```";
		const found = findRefs(text);
		expect(found.map(({ ref: value }) => value)).toEqual([ref("src/cart.ts"), ref("src/a b.ts:add")]);
		expect(blankCode(text)).toHaveLength(text.length);
		expect(blankCode(text).includes(ref("inline.ts"))).toBe(false);
	});

	it("keeps scanning links after malformed inline code and does not cross blank lines", () => {
		for (const newline of ["\n", "\r\n"]) {
			const text = `\`open${newline}${newline}[link](${ref("ok.ts")})`;
			expect(findRefs(text).map(({ ref: value }) => value)).toEqual([ref("ok.ts")]);
		}
	});

	it("finds angled link offsets, ignores escaped brackets, and keeps labels and spans", () => {
		const text = `\\[skip](${ref("skip.ts")}) [name [nested]](<${ref("a b.ts")}> "title") [escaped\\]](${ref("last.ts")})`;
		const links = findRefLinks(text);
		expect(links.map(({ ref: value }) => value)).toEqual([ref("a b.ts"), ref("last.ts")]);
		for (const link of links) expect(text.slice(link.index, link.index + link.ref.length)).toBe(link.ref);
		expect(links[0]?.label).toContain("nested");
		expect(text.slice(links[0]?.from, links[0]?.to)).toContain('"title"');
	});

	it("finds Mermaid click and href targets outside ordinary code fences", () => {
		const text =
			'\n```mermaid\nclick A "' +
			ref("one.ts") +
			'"\nclick B href "' +
			ref("two.ts") +
			'"\n```\n\n```text\nclick C "' +
			ref("hidden.ts") +
			'"\n```';
		expect(findRefs(text).map(({ ref: value }) => value)).toEqual([ref("one.ts"), ref("two.ts")]);
	});

	it("scans legacy refs only when explicitly requested, including Mermaid", () => {
		const text = '[old](ref://src/old.ts)\n\n```mermaid\nclick A "ref://src/diagram.ts"\n```';
		expect(findRefs(text)).toEqual([]);
		expect(findRefs(text, { legacy: true }).map(({ ref: value }) => value)).toEqual([
			"ref://src/old.ts",
			"ref://src/diagram.ts",
		]);
		expect(parseRef("ref://src/old.ts").ok).toBe(false);
	});

	it("parses module paths and qualified symbol chains", () => {
		expect(parseRef(ref("src/a.ts:Cart:Part"))).toEqual({
			ok: true,
			ref: { project, module: "src/a.ts", segments: ["Cart", "Part"] },
		});
		expect(parseRef(ref("README.md"))).toEqual({ ok: true, ref: { project, module: "README.md", segments: [] } });
		expect(parseRef(ref("src/a.ts:Cart::Part:member"))).toEqual({
			ok: true,
			ref: { project, module: "src/a.ts", segments: ["Cart::Part", "member"] },
		});
	});

	it("rejects missing projects, anchors, absolute paths, and empty path or chain parts", () => {
		for (const value of [
			"project-ref:///src/a.ts",
			"project-ref://../src/a.ts",
			"project-ref://a%2Fb/src.ts",
			"project-ref://a/project-ref%3A%2F%2Fb/src.ts",
			"project-ref://a/",
			"project-ref://a/../outside.ts",
			"project-ref://a/%2Fetc/passwd",
			"project-ref://a/C%3A%5Coutside.ts",
			"project-ref://a/src/a.ts#L1",
		])
			expect(parseRef(value).ok, value).toBe(false);
	});

	it("accepts workspace IDs with any safe basename prefix", () => {
		for (const safePrefix of ["_repo", ".repo", "-repo"]) {
			const project = `${safePrefix}-0123456789abcdef`;
			const formatted = formatRef(project, "src/a.ts", []);
			expect(parseRef(formatted)).toEqual({ ok: true, ref: { project, module: "src/a.ts", segments: [] } });
		}
	});

	it("round trips spaces, escaped separators, and URI-significant characters", () => {
		for (const [module, segments] of [
			["src/a b.ts", ["Cart Part", "Part"]],
			["src/hash#name.ts", ["A:B", "C(D)"]],
			["src/100%25.ts", ["A::B", "é!'*()"]],
			["src/a::b.ts", ["::leading", "middle::qualifier", "trailing::"]],
		] as const) {
			const formatted = formatRef(project, module, segments);
			expect(parseRef(formatted)).toEqual({ ok: true, ref: { project, module, segments: [...segments] } });
		}
		expect(formatRef(project, "src/a.ts", ["A:B"])).toContain("A%3AB");
	});

	it("handles scanner worst-case shapes within the note size bound", () => {
		const shapes = [
			`[x](${ref("a.ts")})`,
			`[x](${ref("a.ts")}`,
			`[x](<${ref("a.ts")}`,
			`\\\\\\[x](${ref("a.ts")})`,
			`\`\`\`\`\`\`\`\`\` ${ref("a.ts")}`,
		];
		for (const shape of shapes) {
			const text = shape.repeat(Math.floor(NOTE_MAX / shape.length));
			const start = performance.now();
			findRefs(text);
			expect(performance.now() - start).toBeLessThan(1000);
		}
	});
});
