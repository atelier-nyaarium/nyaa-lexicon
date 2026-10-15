import { describe, expect, it } from "bun:test";
import { RenameEditsResponseSchema } from "../rename.js";
import { notImplementedRenameEdits } from "../serve.js";

describe("notImplementedRenameEdits", () => {
	it("returns the refusal with its detail", () => {
		const response = notImplementedRenameEdits("rename is unavailable");

		expect(RenameEditsResponseSchema.parse(response)).toEqual({
			status: "refused",
			reason: "NotImplemented",
			detail: "rename is unavailable",
		});
	});
});
