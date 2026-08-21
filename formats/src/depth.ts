// The one place a recursion limit is recognized, for every reader that recurses.

/** What a reader says when a structure outruns the stack. */
export const TOO_DEEP = "nested too deeply to index";

/** What a stack exhaustion says, wherever it is met: thrown at us, or already caught by a library. */
export function saysTooDeep(message: string): boolean {
	return /call stack/i.test(message);
}

/**
 * A stack exhaustion, and never another `RangeError`.
 *
 * Catching the type alone would report an out-of-range array length or a bad `toFixed` as a depth
 * problem, which is a real bug wearing a diagnostic that sends the reader somewhere else.
 */
export function isTooDeep(failure: unknown): boolean {
	return failure instanceof RangeError && saysTooDeep(failure.message);
}
