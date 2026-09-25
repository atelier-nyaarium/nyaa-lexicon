// One journaled step over a fake world, with the gate held between its plan and its write.
//
// A plan runs outside the gate and its write inside, so what the world does in between is the
// race the step's stale check exists for. The hold is released only after `between` has run. A
// preview asks the same world with nothing held.

import { applyEdits } from "@nyaa-lexicon/protocol";
import { createDispatch } from "../dispatch";
import { ReadContext } from "../readContext";
import type { RefactorPlanner } from "../refactorPlanner";
import type { LexiconService } from "../service";
import type { IndexStore, StoredDeclaration } from "../store";
import type { TransactionManager } from "../transactions";
import { WorkspaceGate } from "../workspaceGate";

////////////////////////////////
//  Interfaces & Types

export interface StepWorld {
	planner: RefactorPlanner;
	/** The module's text on disk, hashed; null when absent. */
	currentHashOf(module: string): string | null;
	declarationsIn(module: string): StoredDeclaration[];
	/** Backs `newReadContext`; a rename or a move step only. */
	store?: IndexStore;
	/** Text on disk per module, for a rename step's own write; a rename step only. */
	textOf?(module: string): string;
	/** Modules changed on disk since indexing. */
	staleModules?(modules: string[]): string[];
}

export interface Stepped {
	outcome: unknown;
	written: Array<{ module: string; text: string }>;
}

////////////////////////////////
//  Constants

const journal = {
	openTransaction: () => ({ id: "rt-test", startedAt: 0, origin: "explicit" }),
	beginStep: () => ({ ok: true, stepNo: 1 }),
	completeStep: () => {},
	recordIssues: () => {},
	rebind: () => ({ subjects: 0, answers: 0, gaps: 0, applied: [] }),
} as unknown as TransactionManager;

////////////////////////////////
//  Functions & Helpers

/** Run a preview without holding the gate. */
export async function askWith(world: StepWorld, method: "previewMove" | "previewInsert", params: unknown) {
	const written: Stepped["written"] = [];
	const service = serviceFor(world, written, () => {});
	return { answer: await createDispatch(service, { transactions: journal })(method, params), written };
}

export async function stepWith(
	world: StepWorld,
	method: "refactorReplace" | "refactorInsert" | "refactorRename" | "refactorMove",
	params: unknown,
	between: () => void,
): Promise<Stepped> {
	const written: Stepped["written"] = [];
	let planned!: () => void;
	const plannedOnce = new Promise<void>((resolve) => {
		planned = resolve;
	});
	const service = serviceFor(world, written, () => planned());
	const dispatch = createDispatch(service, { transactions: journal });

	let release!: () => void;
	const held = service.gate.exclusive(
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

/** Fires when planning reads finish. */
function serviceFor(world: StepWorld, written: Stepped["written"], planned: () => void): LexiconService {
	const gate = new WorkspaceGate();
	const answering =
		<A extends unknown[], R>(plan: (...args: A) => Promise<R>) =>
		async (...args: A): Promise<R> => {
			const answer = await plan(...args);
			planned();
			return answer;
		};

	return {
		gate,
		upgradeRemaining: async () => {},
		newReadContext: () => new ReadContext(world.store as IndexStore),
		planReplacement: answering((...args: Parameters<RefactorPlanner["planReplacement"]>) =>
			world.planner.planReplacement(...args),
		),
		planInsert: answering((...args: Parameters<RefactorPlanner["planInsert"]>) =>
			world.planner.planInsert(...args),
		),
		planMove: (...args: Parameters<RefactorPlanner["planMove"]>) => world.planner.planMove(...args),
		moveEdits: answering((...args: Parameters<RefactorPlanner["moveEdits"]>) => world.planner.moveEdits(...args)),
		rebaseIntoModule: (...args: Parameters<RefactorPlanner["rebaseIntoModule"]>) =>
			world.planner.rebaseIntoModule(...args),
		checkMoveLanded: (): unknown[] => [],
		prepareRename: (...args: Parameters<RefactorPlanner["prepareRename"]>) => world.planner.prepareRename(...args),
		renameIdMap: (...args: Parameters<RefactorPlanner["renameIdMap"]>) => world.planner.renameIdMap(...args),
		// The last synchronous read a rename plan takes.
		modulesBoundTo: (...args: Parameters<RefactorPlanner["modulesBoundTo"]>) => {
			const answer = world.planner.modulesBoundTo(...args);
			planned();
			return answer;
		},
		renameSymbol: async (symbolId: string, newName: string) => {
			const edits = await world.planner.renameEdits(symbolId, newName);
			if (!edits.ok) return { renamed: false as const, plan: edits.plan, reason: edits.reason };
			const modules: string[] = [];
			for (const file of edits.files) {
				const before = world.textOf?.(file.module) ?? "";
				const applied = applyEdits(before, file.edits);
				if ("problem" in applied) throw new Error(applied.problem);
				written.push({ module: file.module, text: applied.text });
				modules.push(file.module);
			}
			return { renamed: true as const, plan: edits.plan, modules };
		},
		factsMoved: (...args: Parameters<RefactorPlanner["factsMoved"]>) => world.planner.factsMoved(...args),
		currentHashOf: (module: string) => world.currentHashOf(module),
		staleModules: (modules: string[]) => world.staleModules?.(modules) ?? [],
		declarationsIn: (module: string) => world.declarationsIn(module),
		writeModule: (module: string, text: string) => {
			written.push({ module, text });
		},
		indexFile: async (module: string) => ({ module, action: "indexed" }),
	} as unknown as LexiconService;
}
