// The one place a recursion limit is recognized, for every reader that recurses.

/** What a reader says when a structure outruns the stack. */
export const TOO_DEEP = "nested too deeply to index";

/** What a stack exhaustion says, wherever it is met: thrown at us, or already caught by a library. */
export function saysTooDeep(message: string): boolean {
	return /call stack/i.test(message);
}

/** Deeper than any data file; far shallower than what exhausts a stack. */
export const MAX_NESTING = 1_000;

/** A gauge's refusal. */
class NestingLimit extends Error {}

/** Tracks parser-event collections; throws past `limit` to stop parsing. */
export class NestingGauge {
	private depth = 0;

	constructor(private readonly limit = MAX_NESTING) {}

	open(): void {
		this.depth++;
		if (this.depth > this.limit) throw new NestingLimit(TOO_DEEP);
	}

	close(): void {
		if (this.depth > 0) this.depth--;
	}

	/** Closes every collection at once. */
	reset(): void {
		this.depth = 0;
	}
}

/**
 * Recognizes stack exhaustion and gauge refusal, but not other `RangeError`s.
 *
 * Catching the type alone would report an out-of-range array length or a bad `toFixed` as a depth
 * problem, which is a real bug wearing a diagnostic that sends the reader somewhere else.
 */
export function isTooDeep(failure: unknown): boolean {
	return failure instanceof NestingLimit || (failure instanceof RangeError && saysTooDeep(failure.message));
}
