import { describe, expect, it } from "vitest";
import { ResultCache } from "../resultCache";

describe("caching an answer", () => {
	it("computes once and serves the rest", async () => {
		const cache = new ResultCache();
		let computed = 0;
		const compute = async () => {
			computed++;
			return "answer";
		};

		expect(await cache.through("k", compute)).toBe("answer");
		expect(await cache.through("k", compute)).toBe("answer");
		expect(computed).toBe(1);
		expect(cache.stats()).toMatchObject({ hits: 1, misses: 1 });
	});

	it("keeps different questions apart", async () => {
		const cache = new ResultCache();
		expect(await cache.through("a", async () => 1)).toBe(1);
		expect(await cache.through("b", async () => 2)).toBe(2);
	});

	// The property the whole design rests on. A cache that survives a change to the facts is not a
	// cache, it is a source of confidently stale answers.
	it("serves nothing from before the index changed", async () => {
		const cache = new ResultCache();
		await cache.through("k", async () => "old");
		cache.invalidate();

		expect(await cache.through("k", async () => "new")).toBe("new");
	});

	// A transient provider failure must not be remembered as an answer.
	it("stores nothing when the computation throws", async () => {
		const cache = new ResultCache();
		await expect(
			cache.through("k", async () => {
				throw new Error("provider died");
			}),
		).rejects.toThrow("provider died");

		expect(await cache.through("k", async () => "recovered")).toBe("recovered");
	});

	it("stays bounded, so a long session cannot grow one without limit", async () => {
		const cache = new ResultCache(3);
		for (let i = 0; i < 10; i++) await cache.through(`k${i}`, async () => i);

		expect(cache.stats().entries).toBeLessThanOrEqual(3);
	});
});
