// Encodes and decodes the harness-attested author stored with a knowledge row.

import { type NoteAuthor, NoteAuthorSchema } from "@nyaa-lexicon/protocol";

export function authorText(author: NoteAuthor | null | undefined): string | null {
	return author === null || author === undefined ? null : JSON.stringify(author);
}

/** Null for a stored author that no longer parses. */
export function authorOf(text: string | null): NoteAuthor | null {
	if (text === null) return null;
	try {
		const parsed = NoteAuthorSchema.safeParse(JSON.parse(text));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

export function isPerson(author: NoteAuthor | null | undefined): boolean {
	return author?.kind === "person";
}
