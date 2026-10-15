// Turning answers into what an agent reads.
//
// Pure, because output formatting deserves direct tests.

export { renderComments, renderDocs, renderLiterals } from "./render/docs.js";
export { renderCoChange, renderFileHistory, renderMentions } from "./render/history.js";
export { renderNoteBacklinks, renderNoteOutcome, renderNoteSection } from "./render/knowledge.js";
export {
	renderInsertOutcome,
	renderMoveOutcome,
	renderMovePlan,
	renderRefactorCommit,
	renderRefactorStart,
	renderRefactorStatus,
	renderRenamePlan,
	renderRenameStep,
	renderReplaceOutcome,
	renderSymbolSource,
} from "./render/refactor.js";
export { renderIssues } from "./render/shared/issues.js";
export { code } from "./render/shared/markdown.js";
export { renderCandidates, renderDescribe, renderOutline, renderReferences, renderType } from "./render/symbols.js";
export { renderImports, renderMostReferenced, renderOverview, renderSymbolSearch } from "./render/workspace.js";
