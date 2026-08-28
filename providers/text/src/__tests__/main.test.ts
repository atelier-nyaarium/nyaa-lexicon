import { describe, expect, it } from "bun:test";
import { FileFactsSchema } from "@nyaa-lexicon/protocol";
import { TextProvider } from "../main";

describe("text provider", () => {
	it("claims every file as plain text", () => {
		const provider = new TextProvider();
		expect(provider.initialize(".")).toMatchObject({
			providerId: "text-provider",
			language: "text",
			extensions: [],
			fallback: true,
			content: "text",
		});
	});

	it("returns docs at full depth and none at outline depth", () => {
		const provider = new TextProvider();
		const full = provider.parseFile({ module: "Dockerfile", contentHash: "h", text: "FROM base\n\nRUN app\n" });
		const outline = provider.parseFile({
			module: "Dockerfile",
			contentHash: "h",
			text: "FROM base\n",
			depth: "outline",
		});
		expect(FileFactsSchema.parse(full).docs?.map((region) => region.text)).toEqual(["FROM base", "RUN app"]);
		expect(outline.docs).toEqual([]);
	});
});
