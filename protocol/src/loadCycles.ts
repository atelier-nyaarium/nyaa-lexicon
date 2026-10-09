import { z } from "zod";
import { LandingSchema } from "./project.js";
import { RangeSchema } from "./symbols.js";

export const LoadCycleHazardSchema = z
	.object({
		entry: z.string().min(1),
		order: z.array(z.string().min(1)),
		reader: z.object({ module: z.string().min(1), range: RangeSchema, name: z.string().min(1) }),
		/** `symbolId`: the declaration the target names, absent where no workspace declaration has one. */
		target: z.object({
			module: z.string().min(1),
			name: z.string().min(1),
			kind: z.string().min(1),
			symbolId: z.string().min(1).optional(),
		}),
		calls: z.array(z.object({ module: z.string().min(1), range: RangeSchema, name: z.string().min(1) })),
	})
	.meta({ id: "LoadCycleHazard" });

export type LoadCycleHazard = z.infer<typeof LoadCycleHazardSchema>;

/**
 * `runtime`: a member's module system is unreported or not modeled. `notReady`: the provider has
 * nothing to judge with yet. `model`: the walk met code outside the subset it models, at `range`.
 */
export const LoadCycleUnknownSchema = z
	.object({
		module: z.string().min(1).optional(),
		range: RangeSchema.optional(),
		reason: z.enum([
			"undecided",
			"provider",
			"timeout",
			"outage",
			"refused",
			"budget",
			"notReady",
			"runtime",
			"evidence",
			"model",
		]),
	})
	.meta({ id: "LoadCycleUnknown" });

export const LoadCycleMemberSchema = z.object({ module: z.string().min(1), contentHash: z.string().min(1) });
export const JudgeLoadCycleRequestSchema = z
	.object({
		members: z.array(LoadCycleMemberSchema).min(1),
		entries: z.array(z.string().min(1)).min(1).max(32),
		partial: z.string().min(1).optional(),
	})
	.meta({ id: "JudgeLoadCycleRequest" });

export const LoadCycleEvidenceSchema = z.object({
	module: z.string().min(1),
	contentHash: z.string().min(1),
	landings: z.array(z.object({ range: RangeSchema, landing: LandingSchema.nullable() })),
});

export const JudgeLoadCycleAnswerSchema = z
	.union([
		z.object({
			verdict: z.enum(["bad", "fine", "unknown"]),
			bad: z.array(LoadCycleHazardSchema),
			unknowns: z.array(LoadCycleUnknownSchema),
			evidence: z.array(LoadCycleEvidenceSchema),
			settings: z.array(z.object({ project: z.string().min(1), fingerprint: z.string().min(1) })),
		}),
		z.object({ partial: z.string().min(1) }),
	])
	.meta({ id: "JudgeLoadCycleAnswer" });

export type JudgeLoadCycleRequest = z.infer<typeof JudgeLoadCycleRequestSchema>;
export type JudgeLoadCycleAnswer = z.infer<typeof JudgeLoadCycleAnswerSchema>;

/** The provider may drop the state a `partial` token holds; core will not continue it. */
export const ReleaseLoadCycleNotificationSchema = z
	.object({ partial: z.string().min(1) })
	.meta({ id: "ReleaseLoadCycleNotification" });

/** What a provider that does not judge load cycles answers, and what core reads its silence as. */
export function unjudgedLoadCycle(request: JudgeLoadCycleRequest): Extract<JudgeLoadCycleAnswer, { verdict: unknown }> {
	return {
		verdict: "unknown",
		bad: [],
		unknowns: [{ reason: "provider" }],
		evidence: request.members.map((member) => ({ ...member, landings: [] })),
		settings: [],
	};
}

export const ModuleCyclesRequestSchema = z
	.object({
		module: z.string().min(1).optional(),
		verdict: z.enum(["bad", "fine", "unknown"]).optional(),
		includeUnread: z.boolean().optional(),
		limit: z.number().int().min(1).max(200).default(20),
	})
	.meta({ id: "ModuleCyclesRequest" });

export const ModuleCycleSchema = z
	.object({
		modules: z.array(z.string().min(1)),
		verdict: z.enum(["bad", "fine", "unknown"]),
		entries: z.array(z.string().min(1)),
		/** Every value read through a runtime edge inside the component, of which `crossings` lists the first. */
		crossingCount: z.number().int().nonnegative(),
		crossings: z.array(
			z.object({
				module: z.string().min(1),
				range: RangeSchema,
				name: z.string().min(1),
				target: z.string().min(1),
			}),
		),
		bad: z.array(LoadCycleHazardSchema),
		unknowns: z.array(LoadCycleUnknownSchema),
	})
	.meta({ id: "ModuleCycle" });

export type ModuleCycle = z.infer<typeof ModuleCycleSchema>;

export const ModuleProblemsRequestSchema = z
	.object({ module: z.string().min(1) })
	.meta({ id: "ModuleProblemsRequest" });
export const ModuleProblemsResponseSchema = z.array(LoadCycleHazardSchema).meta({ id: "ModuleProblemsResponse" });
