// A described symbol's part in a load-order cycle: the hazards it reads in, or is the target of.

import type { DescribeResult, LoadCycleHazard, ModuleCycle, Position, Range } from "@nyaa-lexicon/protocol";
import type { Clock } from "./clock.js";
import { withTimeout } from "./deadline.js";
import type { StoredDeclaration } from "./store.js";

////////////////////////////////
//  Interfaces & Types

type DescribeLoadCycle = NonNullable<DescribeResult["loadCycle"]>;

/** The described declaration as hazards are matched against it. */
export interface Described {
	symbolId: string;
	module: string;
	range: Range;
	/** Its name under its containers, the outermost first. */
	chain: string[];
}

/** The component holding a module, read without judging it. */
export interface Component {
	modules: string[];
	crossingCount: number;
}

////////////////////////////////
//  Constants

/** How long a describe waits on its component's judgment before answering that it is pending. */
export const LOAD_CYCLE_WAIT_MS = 300;

////////////////////////////////
//  Functions & Helpers

const notAfter = (a: Position, b: Position) => a.line < b.line || (a.line === b.line && a.character <= b.character);

const contains = (outer: Range, inner: Range) => notAfter(outer.start, inner.start) && notAfter(inner.end, outer.end);

/** The declaration `symbolId` names, with its container chain; null when the index holds none. */
export function describedOf(
	symbolId: string,
	declarationOf: (symbolId: string) => StoredDeclaration | null,
): Described | null {
	const declaration = declarationOf(symbolId);
	if (declaration === null) return null;
	const chain = [declaration.name];
	const seen = new Set([symbolId]);
	for (let container = declaration.containerId; container !== undefined && !seen.has(container); ) {
		seen.add(container);
		const held = declarationOf(container);
		if (held === null) break;
		chain.unshift(held.name);
		container = held.containerId;
	}
	return { symbolId, module: declaration.module, range: declaration.range, chain };
}

/**
 * Whether the symbol holds the hazard's read, or is the binding it reads: a top-level symbol by its
 * symbol id when named, or by its top-level name or dotted container chain.
 */
export function involves(symbol: Described, hazard: LoadCycleHazard): boolean {
	if (hazard.reader.module === symbol.module && contains(symbol.range, hazard.reader.range)) return true;
	if (hazard.target.symbolId !== undefined) return hazard.target.symbolId === symbol.symbolId;
	return hazard.target.module === symbol.module && hazard.target.name === symbol.chain.join(".");
}

/**
 * The symbol's part in its component's judgment. No component, or one no value read crosses, holds
 * no hazard and is never judged here. A judgment not ready within `LOAD_CYCLE_WAIT_MS` runs on and
 * is cached for the next describe, and this one answers pending.
 */
export async function loadCycleOf(
	symbol: Described,
	component: Component | null,
	judged: () => Promise<ModuleCycle[]>,
	clock: Clock,
): Promise<DescribeLoadCycle | undefined> {
	if (component === null || component.crossingCount === 0) return undefined;
	// Its reads may outlive the asking request's gate; a failure answers nothing.
	const asked = judged().catch((): ModuleCycle[] => []);
	let answer: ModuleCycle[];
	try {
		answer = await withTimeout(clock, asked, LOAD_CYCLE_WAIT_MS, "describe's load-cycle judgment");
	} catch {
		return { verdict: "pending", modules: component.modules };
	}
	const cycle = answer.find((each) => each.modules.includes(symbol.module));
	if (cycle?.verdict !== "bad") return undefined;
	const hazards = cycle.bad.filter((hazard) => involves(symbol, hazard));
	return hazards.length === 0 ? undefined : { verdict: "bad", modules: cycle.modules, hazards };
}
