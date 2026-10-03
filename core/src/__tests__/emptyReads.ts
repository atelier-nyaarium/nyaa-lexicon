// A store that answers nothing, for a double to spread and then override what its test reads.

import type { DeclarationReads } from "../readContext.js";

/** Every read a read context or a planner takes, each answering empty. */
export const EMPTY_READS: DeclarationReads & {
	contentHashOf(module: string): string | null;
	nextProjectionDebt(): string | null;
} = {
	declaration: () => null,
	declarationsIn: () => [],
	declarationsNamed: () => [],
	referencesTo: () => [],
	usesTo: () => [],
	referencesIn: () => [],
	referencesSpelled: () => [],
	importsBinding: () => [],
	importsNamed: () => [],
	importsIn: () => [],
	exposuresNamed: () => [],
	scopeMembers: () => null,
	scopeGeneration: () => 0,
	symbolIdsIn: () => [],
	stampOf: () => null,
	fileOf: () => null,
	exportsIn: () => [],
	importEdgeAt: () => null,
	exportedDeclarations: () => [],
	scopeExports: () => [],
	effectiveExportsOf: () => [],
	importEdgesLandingOn: () => [],
	modulesExposing: () => [],
	scopesHolding: () => [],
	modulesHoldingNamespace: () => [],
	scopeKeysOf: () => [],
	commentsIn: () => [],
	literalsIn: () => [],
	writerOf: () => null,
	factsGeneration: () => 0,
	contentHashOf: () => null,
	nextProjectionDebt: () => null,
};
