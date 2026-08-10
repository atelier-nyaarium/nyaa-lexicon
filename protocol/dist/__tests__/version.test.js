import { describe, expect, it } from "vitest";
import { isCompatibleProtocol, PROTOCOL_VERSION } from "../index.js";
describe("protocol version", () => {
    it("accepts its own version", () => {
        expect(isCompatibleProtocol(PROTOCOL_VERSION)).toBe(true);
    });
    it("accepts a same-major provider, since changes are additive within a major", () => {
        expect(isCompatibleProtocol("0.9.3")).toBe(true);
    });
    it("refuses a different major", () => {
        expect(isCompatibleProtocol("1.0.0")).toBe(false);
    });
    it("refuses garbage rather than reading it as compatible", () => {
        expect(isCompatibleProtocol("")).toBe(false);
        expect(isCompatibleProtocol("not-a-version")).toBe(false);
    });
});
//# sourceMappingURL=version.test.js.map