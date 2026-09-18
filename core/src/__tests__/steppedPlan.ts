// One journaled step over a fake world, with the gate held between its plan and its write.
//
// A plan runs outside the gate and its write inside, so what the world does in between is the
// race the step's stale check exists for. The hold is released only after `between` has run.

import { createDispatch } from "../dispatch";
import type { RefactorPlanner } from "../refactorPlanner";
import type { LexiconService } from "../service";
import type { StoredDeclaration } from "../store";
import type { TransactionManager } from "../transactions";
import { WorkspaceGate } from "../workspaceGate";

////////////////////////////////
//  Interfaces & Types

export interface StepWorld {
	planner: RefactorPlanner;
	/** The module's text on disk, hashed; null when absent. */
	currentHashOf(module: string): string | null;
	declarationsIn(module: string): StoredDeclaration[];
}

export interface Stepped {
	outcome: unknown;
	written: Array<{ module: string; text: string }>;
}

////////////////////////////////
//  Functions & Helpers

export async function stepWith(
	world: StepWorld,
	method: "refactorReplace" | "refactorInsert",
	params: unknown,
	between: () => void,
): Promise<Stepped> {
	const gate = new WorkspaceGate();
	const written: Stepped["written"] = [];
	let planned!: () => void;
	const plannedOnce = new Promise<void>((resolve) => {
		planned = resolve;
	});
	const answering =
		<A extends unknown[], R>(plan: (...args: A) => Promise<R>) =>
		async (...args: A): Promise<R> => {
			const answer = await plan(...args);
			planned();
			return answer;
		};

	const service = {
		gate,
		upgradeRemaining: async () => {},
		planReplacement: answering((...args: Parameters<RefactorPlanner["planReplacement"]>) =>
			world.planner.planReplacement(...args),
		),
		planInsert: answering((...args: Parameters<RefactorPlanner["planInsert"]>) =>
			world.planner.planInsert(...args),
		),
		factsMoved: (...args: Parameters<RefactorPlanner["factsMoved"]>) => world.planner.factsMoved(...args),
		currentHashOf: (module: string) => world.currentHashOf(module),
		declarationsIn: (module: string) => world.declarationsIn(module),
		writeModule: (module: string, text: string) => {
			written.push({ module, text });
		},
		indexFile: async (module: string) => ({ module, action: "indexed" }),
	} as unknown as LexiconService;

	const transactions = {
		openTransaction: () => ({ id: "rt-test", startedAt: 0, origin: "explicit" }),
		beginStep: () => ({ ok: true, stepNo: 1 }),
		completeStep: () => {},
		recordIssues: () => {},
	} as unknown as TransactionManager;

	const dispatch = createDispatch(service, { transactions });

	let release!: () => void;
	const held = gate.exclusive(
		() =>
			new Promise<void>((resolve) => {
				release = resolve;
			}),
	);
	const call = dispatch(method, params);
	await plannedOnce;
	between();
	release();
	await held;
	return { outcome: await call, written };
}
