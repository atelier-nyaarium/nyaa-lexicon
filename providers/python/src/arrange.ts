// One module's part of an arrangement: members leaving, members landing, and the imports both need.

import {
	type ArrangeEditsRequest,
	type ArrangeImportSite,
	type ArrangeMember,
	coordinatesOf,
	type MoveEditsResponse,
	type OffsetRange,
	type Range,
	type TextCoordinates,
	type TextEdit,
} from "@nyaa-lexicon/protocol";
import {
	type BlockedSite,
	blockedSite,
	declaresName,
	importInsertion,
	importLine,
	locateImportSite,
	type PythonImportAlias,
	type PythonImportStatement,
	type PythonMoveFacts,
	plannedImportFor,
	repointStatement,
	rewriteStatement,
	sameModule,
	useSiteBlocks,
	validateEdits,
} from "./move";

////////////////////////////////
//  Interfaces & Types

/** Aliases leaving each statement. */
type Dropped = Map<PythonImportStatement, PythonImportAlias[]>;

////////////////////////////////
//  Main

export function makeArrangeEdits(request: ArrangeEditsRequest, facts: PythonMoveFacts): MoveEditsResponse {
	const coordinates = coordinatesOf(request.text);
	const syntaxError = facts.diagnostics.find((diagnostic) => diagnostic.severity === "error");
	if (syntaxError !== undefined) {
		return { status: "refused", reason: "ParseError", detail: syntaxError.message };
	}

	const reorder = sameModule(request.fromModule, request.toModule);
	const target = sameModule(request.module, request.toModule);
	if (!reorder && target && request.exists) {
		// The target's own import of a member leaves with the arrangement.
		const collision = request.members.find(
			(member) =>
				!member.comment &&
				member.removal === undefined &&
				declaresName(facts, member.name, (binding) => importsMember(request.importSites, member, binding)),
		);
		if (collision !== undefined) {
			return {
				status: "refused",
				reason: "TargetCollision",
				detail: `the target already declares ${collision.name}`,
			};
		}
	}

	const blocked: BlockedSite[] = [];
	const edits: TextEdit[] = [];
	const removed: OffsetRange[] = [];
	for (const member of request.members) {
		if (member.removal === undefined) continue;
		if (member.comment) {
			const offsets = coordinates.offsetsForRange(member.removal);
			if (offsets === undefined)
				blocked.push(blockedSite(member.removal, "ParseError", "the removal range is outside the module"));
			else {
				edits.push({ range: member.removal, newText: "" });
				removed.push(offsets);
			}
			continue;
		}
		const offsets = coordinates.offsetsForRange(member.removal);
		if (offsets === undefined) {
			blocked.push(blockedSite(member.removal, "ParseError", "the removal range is outside the module"));
		} else {
			edits.push({ range: member.removal, newText: "" });
			removed.push(offsets);
		}
	}

	const landings = landingEdits(coordinates, request.members, blocked);

	// A reorder keeps every binding.
	if (!reorder) {
		for (const member of request.members) blocked.push(...useSiteBlocks(facts, member.sites));

		const imports = dependencyImports(request, facts, blocked);
		const inserted = importInsertion(coordinates, facts, imports);
		if (inserted.blocked !== undefined) blocked.push(inserted.blocked);
		if (inserted.edit !== undefined) edits.push(inserted.edit);

		if (target) {
			const dropped = memberImports(request, facts, blocked);
			const lines = { removed, landings, absorb: imports.length === 0 };
			edits.push(...droppedImportEdits(request.text, coordinates, facts, dropped, lines, blocked));
		} else edits.push(...repointedImports(request, coordinates, facts, blocked));
	}

	// After the imports, so a shared point lists them first.
	edits.push(...landings);
	return validateEdits(coordinates, edits, blocked);
}

/** One edit per landing point, its members' texts in landing order. Python has no export form. */
function landingEdits(coordinates: TextCoordinates, members: ArrangeMember[], blocked: BlockedSite[]): TextEdit[] {
	const landings = new Map<number, TextEdit>();
	for (const member of members) {
		const insertion = member.insertion;
		if (insertion === undefined) continue;
		const offset = coordinates.offsetAt(insertion.position);
		const point = offset === undefined ? undefined : coordinates.positionAt(offset);
		if (offset === undefined || point === undefined) {
			blocked.push(
				blockedSite(
					{ start: insertion.position, end: insertion.position },
					"ParseError",
					"the insertion position is outside the module",
				),
			);
			continue;
		}
		const landing = landings.get(offset) ?? { range: { start: point, end: point }, newText: "" };
		landing.newText += insertion.text;
		landings.set(offset, landing);
	}
	return [...landings.values()];
}

////////////////////////////////
//  Imports

/** What the module must reach, one statement per `from` specifier. */
function dependencyImports(request: ArrangeEditsRequest, facts: PythonMoveFacts, blocked: BlockedSite[]): string[] {
	const statements = new Map<string, string[]>();
	for (const dependency of request.dependencies) {
		const result = plannedImportFor(request, facts, dependency);
		if (result.blocked !== undefined) blocked.push(result.blocked);
		const planned = result.planned;
		if (planned === undefined) continue;
		if (planned.form === "import") {
			statements.set(importLine(planned), []);
			continue;
		}
		const head = `from ${planned.specifier} import`;
		const names = statements.get(head) ?? [];
		const name =
			planned.importedName === planned.localName
				? planned.importedName
				: `${planned.importedName} as ${planned.localName}`;
		if (!names.includes(name)) names.push(name);
		statements.set(head, names);
	}
	return [...statements].map(([head, names]) => (names.length === 0 ? head : `${head} ${names.join(", ")}`));
}

/** Each statement naming members, re-pointed at the target once. */
function repointedImports(
	request: ArrangeEditsRequest,
	coordinates: TextCoordinates,
	facts: PythonMoveFacts,
	blocked: BlockedSite[],
): TextEdit[] {
	const statements = new Map<PythonImportStatement, { aliases: PythonImportAlias[]; range: Range }>();
	for (const site of request.importSites) {
		const located = locateImportSite(facts, site);
		if ("blocked" in located) {
			blocked.push(located.blocked);
			continue;
		}
		const group = statements.get(located.statement) ?? { aliases: [], range: site.range };
		if (!group.aliases.includes(located.alias)) group.aliases.push(located.alias);
		statements.set(located.statement, group);
	}

	const edits: TextEdit[] = [];
	for (const [statement, group] of statements) {
		const result = repointStatement(
			request.module,
			request.toModule,
			coordinates,
			facts,
			statement,
			group.aliases,
			group.range,
		);
		if (result.blocked !== undefined) blocked.push(result.blocked);
		if (result.edit !== undefined) edits.push(result.edit);
	}
	return edits;
}

/** The target's imports of incoming members, which become its own declarations. */
function memberImports(request: ArrangeEditsRequest, facts: PythonMoveFacts, blocked: BlockedSite[]): Dropped {
	const dropped: Dropped = new Map();
	for (const site of request.importSites) {
		const located = locateImportSite(facts, site);
		if ("blocked" in located) {
			blocked.push(located.blocked);
			continue;
		}
		const name = request.members.find((member) => member.symbolId === site.symbolId)?.name;
		const { alias, statement } = located;
		if (alias.name !== name || alias.localName !== name) {
			blocked.push(
				blockedSite(site.range, "NotImplemented", `the target imports ${alias.name} as ${alias.localName}`),
			);
			continue;
		}
		const aliases = dropped.get(statement) ?? [];
		if (!aliases.includes(alias)) aliases.push(alias);
		dropped.set(statement, aliases);
	}
	return dropped;
}

function importsMember(
	sites: ArrangeImportSite[],
	member: ArrangeMember,
	binding: { specifier: string; localName: string },
): boolean {
	return sites.some(
		(site) =>
			site.symbolId === member.symbolId &&
			site.specifier === binding.specifier &&
			(site.localName ?? site.importedName) === binding.localName,
	);
}

////////////////////////////////
//  Statement Removal

/** Rewrites statements that keep aliases; removes whole lines of the rest. */
function droppedImportEdits(
	text: string,
	coordinates: TextCoordinates,
	facts: PythonMoveFacts,
	dropped: Dropped,
	lines: { removed: OffsetRange[]; landings: TextEdit[]; absorb: boolean },
	blocked: BlockedSite[],
): TextEdit[] {
	const edits: TextEdit[] = [];
	const whole: PythonImportStatement[] = [];
	for (const [statement, aliases] of dropped) {
		const kept = statement.aliases.filter((alias) => !aliases.includes(alias));
		if (coordinates.offsetsForRange(statement.range) === undefined) {
			blocked.push(
				blockedSite(statement.range, "ParseError", "the import statement range is outside the module"),
			);
		} else if (kept.length > 0) {
			const result = rewriteStatement(
				facts,
				statement,
				[{ specifier: statement.specifier, aliases: kept }],
				statement.range,
			);
			if (result.blocked !== undefined) blocked.push(result.blocked);
			if (result.edit !== undefined) edits.push(result.edit);
		} else if (ownsLines(coordinates, statement)) {
			whole.push(statement);
		} else {
			blocked.push(
				blockedSite(statement.range, "NotImplemented", "the import does not stand alone on top-level lines"),
			);
		}
	}
	if (whole.length === 0) return edits;

	const count = text === "" ? 0 : coordinates.lineCount() - (text.endsWith("\n") ? 1 : 0);
	const lineSpan = (line: number) => ({
		start: coordinates.offsetAt({ line, character: 0 }) ?? text.length,
		end: line + 1 < count ? (coordinates.offsetAt({ line: line + 1, character: 0 }) ?? text.length) : text.length,
	});
	const cleared = (line: number) => {
		const span = lineSpan(line);
		return lines.removed.some((range) => range.start <= span.start && span.end <= range.end);
	};
	const blank = (line: number) => (coordinates.lineText(line) ?? "").trim() === "";
	const stops = new Set(lines.landings.map((landing) => landing.range.start.line));

	const drop = new Set<number>();
	for (const statement of whole) {
		for (let line = statement.range.start.line; line <= statement.range.end.line; line++) drop.add(line);
	}
	const gone = (line: number) => drop.has(line) || cleared(line);
	// With nothing kept above, the blank lines below go too; added imports keep them.
	if (lines.absorb) {
		for (const statement of whole) {
			let above = statement.range.start.line - 1;
			while (above >= 0 && gone(above)) above -= 1;
			if (above >= 0 && !blank(above)) continue;
			for (let line = statement.range.end.line + 1; line < count && !stops.has(line); line++) {
				if (gone(line)) continue;
				if (!blank(line)) break;
				drop.add(line);
			}
		}
	}

	// A landing point splits a run, so it falls between removals.
	const runs: Array<{ first: number; last: number }> = [];
	for (const line of [...drop].sort((left, right) => left - right)) {
		const run = runs.at(-1);
		if (run !== undefined && run.last === line - 1 && !stops.has(line)) run.last = line;
		else runs.push({ first: line, last: line });
	}
	const textEnd = coordinates.positionAt(text.length) ?? { line: count, character: 0 };
	for (const { first, last } of runs) {
		const end = last + 1 < count ? { line: last + 1, character: 0 } : textEnd;
		edits.push({ range: { start: { line: first, character: 0 }, end }, newText: "" });
	}
	return edits;
}

/** Starts a top-level line and ends one, a comment aside. */
function ownsLines(coordinates: TextCoordinates, statement: PythonImportStatement): boolean {
	if (statement.indent !== "") return false;
	const rest = coordinates.lineText(statement.range.end.line)?.slice(statement.range.end.character).trim();
	return rest === "" || rest?.startsWith("#") === true;
}
