import { describe, expect, it } from "vitest";
import { lingerWhileEmpty } from "../lifetime";

////////////////////////////////
//  Helpers

/** A clock the test advances by hand, so no case here is decided by waiting. */
function fakeClock() {
	const timers = new Map<number, { fn: () => void; at: number }>();
	let now = 0;
	let nextId = 1;

	return {
		setTimer: (fn: () => void, ms: number) => {
			const id = nextId++;
			timers.set(id, { fn, at: now + ms });
			return id;
		},
		clearTimer: (handle: unknown) => {
			timers.delete(handle as number);
		},
		advance: (ms: number) => {
			now += ms;
			for (const [id, timer] of [...timers]) {
				if (timer.at <= now) {
					timers.delete(id);
					timer.fn();
				}
			}
		},
		pending: () => timers.size,
	};
}

function linger(afterMs = 1000) {
	const clock = fakeClock();
	const stops: number[] = [];
	const subject = lingerWhileEmpty({
		afterMs,
		stop: () => stops.push(1),
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
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
