import type { ArrangeEditsRequest } from "../move.js";
import { composeSymbolId } from "../symbolId.js";
import type { MethodResponse, ProviderSession } from "./providerSession.js";
import { Stall } from "./providerSession.js";
import type { CaseResult } from "./types.js";

/**
 * A code provider's own vocabulary is not visible in facts, so it must state it: a highlighter has
 * nowhere else to learn a language's keywords. A data format ships none, honestly.
 */
function checkWordsDeclared(info: Pick<MethodResponse<"initialize">, "content" | "words">): CaseResult {
	const problems: string[] = [];
	const isDataFormat = info.content !== undefined && info.content !== "code";
	if (!isDataFormat && info.words.keywords.length === 0) {
		problems.push("a code provider announced no keywords at initialize");
	}
	return {
		caseId: "code-provider-declares-keywords",
		tier: "protocol",
		outcome: problems.length === 0 ? "passed" : "failed",
		problems,
	};
}

/** Bad request, never a diagnostic. */
async function checkBadModuleIsRefused(session: ProviderSession): Promise<CaseResult> {
	const problems: string[] = [];
	for (const module of ["../escaped.probe", "/absolute.probe"]) {
		try {
			await session.call("parseFile", { module, contentHash: "h0", text: "" });
			problems.push(`parseFile answered for ${JSON.stringify(module)}, which no symbol id can name`);
		} catch (error) {
			if (error instanceof Stall) throw error;
		}
	}
	return {
		caseId: "unrepresentable-module-is-refused",
		tier: "protocol",
		outcome: problems.length === 0 ? "passed" : "failed",
		problems,
	};
}

/**
 * Every provider answers moveEdits, and one that cannot move refuses rather than agreeing.
 *
 * Ungated by tier: a ready response with no edits and no blocked sites is indistinguishable from a
 * move that had nothing to do, so the core would relocate a declaration and leave every import
 * pointing at the old module.
 */
async function checkMoveIsAnswered(session: ProviderSession): Promise<CaseResult> {
	const problems: string[] = [];

	try {
		const answer = await session.call("moveEdits", {
			module: "src/probe-target",
			text: "",
			exists: false,
			symbolId: composeSymbolId({
				language: "probe",
				module: "src/probe-source",
				descriptors: [{ kind: "term", name: "probe" }],
			}),
			name: "probe",
			fromModule: "src/probe-source",
			toModule: "src/probe-target",
			role: {},
			importSites: [],
			dependencies: [],
			sites: [],
		});

		if (answer.status === "ready" && answer.edits.length === 0 && answer.blocked.length === 0) {
			problems.push("moveEdits answered ready with nothing to do, which reads as a move that succeeded");
		}
	} catch (error) {
		if (error instanceof Stall) throw error;
		problems.push(error instanceof Error ? error.message : String(error));
	}

	return {
		caseId: "moveEdits-is-answered",
		tier: "protocol",
		outcome: problems.length === 0 ? "passed" : "failed",
		problems,
	};
}

/**
 * Every provider answers arrangeEdits, and one that cannot arrange refuses rather than agreeing.
 *
 * Ungated by tier, as moveEdits is. The probe asks for an insertion, so ready with nothing to do
 * would have the core report a member landed that never did.
 */
async function checkArrangeIsAnswered(session: ProviderSession): Promise<CaseResult> {
	const problems: string[] = [];

	try {
		const request: ArrangeEditsRequest = {
			module: "src/probe-target",
			text: "",
			exists: false,
			fromModule: "src/probe-source",
			toModule: "src/probe-target",
			members: [
				{
					symbolId: composeSymbolId({
						language: "probe",
						module: "src/probe-source",
						descriptors: [{ kind: "term", name: "probe" }],
					}),
					name: "probe",
					insertion: { text: "probe\n", position: { line: 0, character: 0 } },
					sites: [],
				},
			],
			importSites: [],
			dependencies: [],
		};
		const answer = await session.call("arrangeEdits", request);

		if (answer.status === "ready" && answer.edits.length === 0 && answer.blocked.length === 0) {
			problems.push(
				"arrangeEdits answered ready with nothing to do, which reads as an arrangement that succeeded",
			);
		}
	} catch (error) {
		if (error instanceof Stall) throw error;
		problems.push(error instanceof Error ? error.message : String(error));
	}

	return {
		caseId: "arrangeEdits-is-answered",
		tier: "protocol",
		outcome: problems.length === 0 ? "passed" : "failed",
		problems,
	};
}

/**
 * Every provider answers importEdits, and none claims empty text already binds the name, which would
 * have a caller skip an import the code needs.
 */
async function checkImportIsAnswered(session: ProviderSession): Promise<CaseResult> {
	const problems: string[] = [];

	try {
		const answer = await session.call("importEdits", {
			module: "src/probe-target",
			text: "",
			name: "probe",
			fromModule: "src/probe-source",
		});
		if (answer.status === "present") {
			problems.push("importEdits answered present for text that binds nothing");
		}
	} catch (error) {
		if (error instanceof Stall) throw error;
		problems.push(error instanceof Error ? error.message : String(error));
	}

	return {
		caseId: "importEdits-is-answered",
		tier: "protocol",
		outcome: problems.length === 0 ? "passed" : "failed",
		problems,
	};
}

export {
	checkArrangeIsAnswered,
	checkBadModuleIsRefused,
	checkImportIsAnswered,
	checkMoveIsAnswered,
	checkWordsDeclared,
};
