import { describe, expect, it } from "vitest";
import type { Session } from "../connect";

////////////////////////////////
//  Helpers

/**
 * Never called. The proof is `tsc --build`: an `@ts-expect-error` with nothing to expect fails the
 * gate, so each marked line is a mistake the facade's typing catches.
 */
function typing(session: Session): void {
	void session.cacheStats({});
	void session.describe({ symbolId: "x" });
	// @ts-expect-error a field the request schema does not declare
	void session.describe({ symbol: "x" });
	// @ts-expect-error a required field left out
	void session.describe({});
	// @ts-expect-error a method the table does not declare
	void session.describeSymbol({ symbolId: "x" });
	// @ts-expect-error the same mistake through ask
	void session.ask("describeSymbol", { symbolId: "x" });
}

////////////////////////////////
//  Tests

describe("the facade's typing", () => {
	it("is checked by the lint gate, where the fixture above compiles only with every marked error present", () => {
		expect(typeof typing).toBe("function");
	});
});
