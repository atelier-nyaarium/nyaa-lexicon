import { describe, expect, it } from "vitest";
import { lingerWhileEmpty } from "../lifetime";
import { fakeClock } from "./fakeClock";

////////////////////////////////
//  Helpers

function linger(afterMs = 1000) {
	const clock = fakeClock();
	const stops: number[] = [];
	const subject = lingerWhileEmpty({
		afterMs,
		stop: () => stops.push(1),
		clock,
	});
	return { clock, stops, subject };
}

////////////////////////////////
//  Tests

describe("lingering while empty", () => {
	it("stops a daemon nobody is connected to, once the wait has passed", () => {
		const { clock, stops, subject } = linger();

		subject.observe(0);
		expect(subject.armed()).toBe(true);

		clock.advance(999);
		expect(stops).toHaveLength(0);

		clock.advance(1);
		expect(stops).toHaveLength(1);
		expect(subject.armed()).toBe(false);
	});

	it("never stops a daemon while a client is connected, however long it idles", () => {
		const { clock, stops, subject } = linger();

		subject.observe(1);
		clock.advance(1_000_000);

		expect(stops).toHaveLength(0);
		expect(subject.armed()).toBe(false);
	});

	// The whole point of the multi-client change: the last session leaving is what starts the
	// clock, not the session that happened to spawn the daemon.
	it("starts the clock when the last client leaves, and stops it when one returns", () => {
		const { clock, stops, subject } = linger();

		subject.observe(2);
		subject.observe(1);
		expect(subject.armed()).toBe(false);

		subject.observe(0);
		expect(subject.armed()).toBe(true);

		clock.advance(500);
		subject.observe(1);
		expect(subject.armed()).toBe(false);

		clock.advance(1_000_000);
		expect(stops).toHaveLength(0);
	});

	it("gives a returning-then-leaving client the full wait again, rather than the remainder", () => {
		const { clock, stops, subject } = linger();

		subject.observe(0);
		clock.advance(900);
		subject.observe(1);
		subject.observe(0);

		clock.advance(900);
		expect(stops).toHaveLength(0);

		clock.advance(100);
		expect(stops).toHaveLength(1);
	});

	it("keeps one timer at most, so a flapping client cannot stack shutdowns", () => {
		const { clock, stops, subject } = linger();

		for (let i = 0; i < 10; i++) subject.observe(0);
		expect(clock.pending()).toBe(1);

		clock.advance(1000);
		expect(stops).toHaveLength(1);
	});

	it("cancels for good, so a daemon stopping for another reason does not stop twice", () => {
		const { clock, stops, subject } = linger();

		subject.observe(0);
		subject.cancel();
		clock.advance(1_000_000);
		expect(stops).toHaveLength(0);

		subject.observe(0);
		expect(subject.armed()).toBe(false);
	});
});

// Issue #7: counting only connections stopped the daemon under a running rename the moment its
// client timed out and disconnected.
describe("holding the linger while work is in flight", () => {
	function heldLinger(busy: { reason: string | null }) {
		const clock = fakeClock();
		const stops: number[] = [];
		const held: string[] = [];
		const subject = lingerWhileEmpty({
			afterMs: 1000,
			stop: () => stops.push(1),
			holdWhile: () => busy.reason,
			onHeld: (reason) => held.push(reason),
			clock,
		});
		return { clock, stops, held, subject };
	}

	it("re-arms instead of stopping while something is running, and says what", () => {
		const busy = { reason: "1 request(s) in flight" as string | null };
		const { clock, stops, held, subject } = heldLinger(busy);

		subject.observe(0);
		clock.advance(1000);

		expect(stops).toHaveLength(0);
		expect(held).toEqual(["1 request(s) in flight"]);
		expect(subject.armed()).toBe(true);
	});

	it("stops on the first fire after the work drains", () => {
		const busy = { reason: "a refactor transaction is open" as string | null };
		const { clock, stops, subject } = heldLinger(busy);

		subject.observe(0);
		clock.advance(1000);
		expect(stops).toHaveLength(0);

		busy.reason = null;
		clock.advance(1000);
		expect(stops).toHaveLength(1);
		expect(subject.armed()).toBe(false);
	});

	it("a hold gets the full wait again, not the remainder", () => {
		const busy = { reason: "busy" as string | null };
		const { clock, stops, subject } = heldLinger(busy);

		// Held at 1000, so the next chance is 2000, never 1001.
		subject.observe(0);
		clock.advance(1000);
		busy.reason = null;
		clock.advance(999);
		expect(stops).toHaveLength(0);
		clock.advance(1);
		expect(stops).toHaveLength(1);
	});

	it("cancelling during a hold means no stop ever comes", () => {
		const busy = { reason: "busy" as string | null };
		const { clock, stops, subject } = heldLinger(busy);

		subject.observe(0);
		clock.advance(1000);
		subject.cancel();
		busy.reason = null;
		clock.advance(10_000);

		expect(stops).toHaveLength(0);
	});

	// A cancel arriving from INSIDE the hold callback must not be re-armed over.
	it("does not re-arm past a cancel issued by onHeld itself", () => {
		const clock = fakeClock();
		const stops: number[] = [];
		const subject = lingerWhileEmpty({
			afterMs: 1000,
			stop: () => stops.push(1),
			holdWhile: () => "busy",
			onHeld: () => subject.cancel(),
			clock,
		});

		subject.observe(0);
		clock.advance(1000);

		expect(subject.armed()).toBe(false);
		expect(clock.pending()).toBe(0);
		expect(stops).toHaveLength(0);
	});
});
