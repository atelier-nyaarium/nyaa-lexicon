////////////////////////////////
//  Constants

const MAJOR_8 = 8;

////////////////////////////////
//  Functions & Helpers

function recordOf(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function downgradeNote(note: unknown): unknown {
	const record = recordOf(note);
	if (record === null || !Array.isArray(record["links"])) return note;
	let changed = false;
	const links = record["links"].map((value) => {
		const link = recordOf(value);
		if (link?.["state"] !== "withheld") return value;
		changed = true;
		return { ...link, state: "broken" };
	});
	return changed ? { ...record, links } : note;
}

function downgradeWriteNote(answer: unknown): unknown {
	const outcome = recordOf(answer);
	if (outcome?.["outcome"] === "saved") return { ...outcome, note: downgradeNote(outcome["note"]) };
	if (outcome?.["outcome"] === "refused") return { ...outcome, current: downgradeNote(outcome["current"]) };
	return answer;
}

const MAJOR_8_ANSWER_DOWNGRADERS = {
	readNote: downgradeNote,
	writeNote: downgradeWriteNote,
} as const;

export const MAJOR_8_DOWNGRADE_METHODS = Object.freeze(
	Object.keys(MAJOR_8_ANSWER_DOWNGRADERS),
) as readonly (keyof typeof MAJOR_8_ANSWER_DOWNGRADERS)[];

/** Normalize answer shape. */
export function downgradeAnswerForClientMajor(method: string, answer: unknown, clientMajor: number): unknown {
	if (clientMajor !== MAJOR_8) return answer;
	const downgrade = MAJOR_8_ANSWER_DOWNGRADERS[method as keyof typeof MAJOR_8_ANSWER_DOWNGRADERS];
	return downgrade === undefined ? answer : downgrade(answer);
}
