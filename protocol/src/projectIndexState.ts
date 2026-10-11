import { z } from "zod";

export const ProjectIndexStateSchema = z
	.object({ version: z.literal(1), root: z.string().min(1), indexedAt: z.number().finite() })
	.meta({ id: "ProjectIndexState" });

export type ProjectIndexState = z.infer<typeof ProjectIndexStateSchema>;
