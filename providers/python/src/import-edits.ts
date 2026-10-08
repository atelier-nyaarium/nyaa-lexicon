// One import added to a module's text: `from <module> import <name>`, written where a move writes its
// imports, at the end of the prologue.

import { coordinatesOf, type ImportEditsRequest, type ImportEditsResponse } from "@nyaa-lexicon/protocol";
import {
	declaresName,
	hasExistingBinding,
	importInsertion,
	importLine,
	type PythonMoveFacts,
	renderPythonSpecifier,
} from "./move";

////////////////////////////////
//  Main

export function makeImportEdits(request: ImportEditsRequest, facts: PythonMoveFacts): ImportEditsResponse {
	const syntaxError = facts.diagnostics.find((diagnostic) => diagnostic.severity === "error");
	if (syntaxError !== undefined) return { status: "refused", reason: "ParseError", detail: syntaxError.message };
	const rendered = renderPythonSpecifier(request.module, request.fromModule);
	if ("reason" in rendered) {
		const reason = rendered.reason === "AmbiguousImportPath" ? rendered.reason : "NoImportPath";
		return { status: "refused", reason, detail: rendered.detail };
	}
	const { name } = request;
	if (hasExistingBinding(facts, request.module, name, rendered.specifier)) return { status: "present" };
	if (declaresName(facts, name)) {
		return { status: "refused", reason: "TargetCollision", detail: `the module already binds ${name}` };
	}
	const inserted = importInsertion(coordinatesOf(request.text), facts, [
		importLine({ form: "from", specifier: rendered.specifier, importedName: name, localName: name }),
	]);
	if (inserted.edit === undefined) {
		return { status: "refused", reason: "ParseError", detail: inserted.blocked?.detail ?? "no insertion point" };
	}
	return { status: "planned", edits: [inserted.edit] };
}
