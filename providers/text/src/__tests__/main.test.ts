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
		const explicitFull = provider.parseFile({
			module: "Dockerfile",
			contentHash: "h",
			text: "FROM base\n",
			depth: "full",
		});
		expect(FileFactsSchema.parse(full).docs?.map((region) => region.text)).toEqual(["FROM base", "RUN app"]);
		expect(outline.docs).toEqual([]);
		expect(FileFactsSchema.parse(explicitFull).depth).toBe("full");
	});

	it("keeps the rename refusal detail", () => {
		const response = new TextProvider().renameEdits({
			module: "Dockerfile",
			text: "",
			oldName: "a",
			newName: "b",
			sites: [],
		});

		expect(response).toMatchObject({
			status: "refused",
			reason: "NotImplemented",
			detail: "plain text has no symbols",
		});
	});
});
