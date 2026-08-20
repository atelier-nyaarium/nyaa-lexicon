import { describe, expect, it } from "vitest";
import { isCompatibleProtocol, PROTOCOL_VERSION } from "../index.js";

describe("protocol version", () => {
	it("accepts its own version", () => {
		expect(isCompatibleProtocol(PROTOCOL_VERSION)).toBe(true);
	});

	// Derived from the live constant, so a version bump changes what these test, never whether.
	const major = Number(PROTOCOL_VERSION.split(".")[0]);

	it("accepts a same-major provider, since changes are additive within a major", () => {
		expect(isCompatibleProtocol(`${major}.9.3`)).toBe(true);
	});

	it("refuses a different major, in both directions", () => {
		expect(isCompatibleProtocol(`${major + 1}.0.0`)).toBe(false);
		// The previous major's wire: a provider still emitting it cannot serve this one.
		if (major > 0) expect(isCompatibleProtocol(`${major - 1}.9.9`)).toBe(false);
	});

	it("refuses garbage rather than reading it as compatible", () => {
		expect(isCompatibleProtocol("")).toBe(false);
		expect(isCompatibleProtocol("not-a-version")).toBe(false);
	});
});
