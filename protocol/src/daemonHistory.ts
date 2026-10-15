import { z } from "zod";

////////////////////////////////
//  History

export const FileHistoryCommitSchema = z
	.object({ hash: z.string(), at: z.number(), added: z.number(), deleted: z.number(), subject: z.string() })
	.meta({ id: "FileHistoryCommit" });

export type FileHistoryCommit = z.infer<typeof FileHistoryCommitSchema>;

/** What history says about one file on its own. Churn is lines rather than commits. */
export const FileHistorySchema = z
	.object({
		module: z.string(),
		/** Commits touching it, within the window read. */
		commits: z.number(),
		linesAdded: z.number(),
		linesDeleted: z.number(),
		recent: z.array(FileHistoryCommitSchema),
		/** Author time of the oldest and newest commit touching it, unix seconds. */
		firstSeen: z.number().nullable(),
		lastTouched: z.number().nullable(),
		/** True when the oldest commit read also touched this file, so `firstSeen` is a floor. */
		truncated: z.boolean(),
	})
	.meta({ id: "FileHistory" });

export type FileHistory = z.infer<typeof FileHistorySchema>;

export const CoChangeSchema = z
	.object({
		module: z.string(),
		/** Commits touching both files. */
		together: z.number(),
		/** Commits touching the queried file at all, so `together` can be read as a proportion. */
		outOf: z.number(),
	})
	.meta({ id: "CoChange" });

export type CoChange = z.infer<typeof CoChangeSchema>;

export const CoChangedWithResultSchema = z
	.object({
		module: z.string(),
		partners: z.array(CoChangeSchema),
		total: z.number(),
		/** Commits actually read. Fewer than asked for is normal in a young repository. */
		commits: z.number(),
		/** Commits ignored for touching too many files, and the threshold that did it. */
		skippedWideCommits: z.number(),
		widthLimit: z.number(),
	})
	.meta({ id: "CoChangedWithResult" });

export type CoChangedWithResult = z.infer<typeof CoChangedWithResultSchema>;

/** A commit whose message names a symbol. */
export const MentionSchema = z
	.object({
		hash: z.string(),
		at: z.number(),
		/** First line only. */
		subject: z.string(),
		/** Files it touched, so a mention of a common word is judgeable rather than merely present. */
		files: z.number(),
	})
	.meta({ id: "Mention" });

export type Mention = z.infer<typeof MentionSchema>;

export const CommitsMentioningResultSchema = z
	.object({ name: z.string(), mentions: z.array(MentionSchema), commits: z.number() })
	.meta({ id: "CommitsMentioningResult" });

export type CommitsMentioningResult = z.infer<typeof CommitsMentioningResultSchema>;
