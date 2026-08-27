// One owner of "how many, and how sure".

import type { Count, Counted } from "@nyaa-lexicon/protocol";

export type { Count, Counted, CountReason } from "@nyaa-lexicon/protocol";

////////////////////////////////
//  Interfaces & Types

export interface Paged<T> {
	items: T[];
	count: Count;
}

////////////////////////////////
//  Functions & Helpers

export function wire<T>(page: Paged<T>): Counted {
	const { count } = page;
	const scanCapped = count.kind === "atLeast" && count.reason !== "pageCapped";
	return {
		count,
		total: count.count,
		truncated: count.count > page.items.length,
		...(scanCapped ? { scanIncomplete: true } : {}),
	};
}

/** The store counted everything. */
export function pageCounted<T>(found: T[], limit: number, total: number): Paged<T> {
	return { items: found.slice(0, limit), count: { kind: "exact", count: total } };
}

/** Read `limit + 1`: an overflow is a floor. */
export function pageProbed<T>(found: T[], limit: number, scan?: { read: number; cap: number }): Paged<T> {
	const items = found.slice(0, limit);
	const scanCapped = scan !== undefined && scan.read >= scan.cap;
	if (found.length > limit) {
		return {
			items,
			count: { kind: "atLeast", count: limit + 1, reason: scanCapped ? "pageAndScanCapped" : "pageCapped" },
		};
	}
	if (scanCapped) return { items, count: { kind: "atLeast", count: found.length, reason: "scanCapped" } };
	return { items, count: { kind: "exact", count: found.length } };
}

/** Filtered a scan bounded at `cap`. */
export function pageScanned<T>(matched: T[], limit: number, scan: { read: number; cap: number }): Paged<T> {
	const items = matched.slice(0, limit);
	if (scan.read < scan.cap) return { items, count: { kind: "exact", count: matched.length } };
	const reason = matched.length > limit ? "pageAndScanCapped" : "scanCapped";
	return { items, count: { kind: "atLeast", count: matched.length, reason } };
}
