import { describe, expect, it } from "vitest";
import { pageCounted, pageProbed, pageScanned, wire } from "../paging";

const rows = (n: number) => Array.from({ length: n }, (_, index) => index);

describe("a count that carries its own certainty", () => {
	it("is exact when the store counted, and truncated only past the page", () => {
		expect(wire(pageCounted(rows(3), 10, 3))).toEqual({
			count: { kind: "exact", count: 3 },
			total: 3,
			truncated: false,
		});
		expect(wire(pageCounted(rows(10), 10, 312))).toEqual({
			count: { kind: "exact", count: 312 },
			total: 312,
			truncated: true,
		});
	});

	// The original bug: probe size as total.
	it("calls a probe that overflowed a floor of limit + 1, never a total", () => {
		const page = pageProbed(rows(51), 50);
		expect(page.items).toHaveLength(50);
		expect(wire(page)).toEqual({
			count: { kind: "atLeast", count: 51, reason: "pageCapped" },
			total: 51,
			truncated: true,
		});
		expect(wire(pageProbed(rows(7), 50))).toEqual({
			count: { kind: "exact", count: 7 },
			total: 7,
			truncated: false,
		});
	});

	it("is exact for a finished scan however many matched, and a floor once the scan hit its cap", () => {
		const finished = pageScanned(rows(80), 50, { read: 1_000, cap: 20_000 });
		expect(wire(finished)).toEqual({ count: { kind: "exact", count: 80 }, total: 80, truncated: true });

		const capped = pageScanned(rows(12), 50, { read: 20_000, cap: 20_000 });
		expect(wire(capped)).toEqual({
			count: { kind: "atLeast", count: 12, reason: "scanCapped" },
			total: 12,
			truncated: false,
			scanIncomplete: true,
		});

		const both = pageScanned(rows(80), 50, { read: 20_000, cap: 20_000 });
		expect(wire(both)).toEqual({
			count: { kind: "atLeast", count: 80, reason: "pageAndScanCapped" },
			total: 80,
			truncated: true,
			scanIncomplete: true,
		});
	});

	it("tells a probe inside a capped scan from one that finished", () => {
		expect(wire(pageProbed(rows(51), 50, { read: 20_000, cap: 20_000 })).count).toEqual({
			kind: "atLeast",
			count: 51,
			reason: "pageAndScanCapped",
		});
		expect(wire(pageProbed(rows(3), 50, { read: 20_000, cap: 20_000 })).count).toEqual({
			kind: "atLeast",
			count: 3,
			reason: "scanCapped",
		});
		expect(wire(pageProbed(rows(3), 50, { read: 40, cap: 20_000 })).count).toEqual({ kind: "exact", count: 3 });
	});

	it("answers an empty capped scan as a floor of zero, not as nothing", () => {
		expect(wire(pageScanned([], 50, { read: 20_000, cap: 20_000 }))).toEqual({
			count: { kind: "atLeast", count: 0, reason: "scanCapped" },
			total: 0,
			truncated: false,
			scanIncomplete: true,
		});
	});
});
