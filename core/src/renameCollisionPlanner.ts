import type { Meaning, Position, Range, RenameSite } from "@nyaa-lexicon/protocol";
import { ownerOf, parseSymbolId, positionInRange, sameRange } from "@nyaa-lexicon/protocol";
import { narrowed } from "./exportProjection.js";
import type { ReadContext } from "./readContext.js";
import type { RenameBlocker } from "./refusalSlots.js";
import { nameAlreadyDeclared, nameAlreadyImported } from "./refusals.js";
import { startKey } from "./renameRoutes.js";
import type { StoredDeclaration, StoredImport } from "./store.js";

////////////////////////////////
//  Functions & Helpers

function inside(range: Range, at: Position): boolean {
	return positionInRange(range, at);
}

/** Member type, or null. */
function memberOwner(symbolId: string): string | null {
	const id = parseSymbolId(symbolId);
	if (id === null || id.local !== undefined || id.descriptors.at(-2)?.kind !== "type") return null;
	return ownerOf(symbolId);
}

export class RenameCollisionPlanner {
	/**
	 * Places a rewritten occurrence would resolve the new name to something else.
	 *
	 * A declaration collides when its scope holds a rename site, when it is a member of the renamed
	 * member's type, or when the renamed symbol nests inside its scope around one of its uses. A
	 * member's own declaration, a site the parser marked `qualified`, and a token that binds nothing, such
	 * as a forward's, are no sites here: no local can capture them. A declaration's container is its
	 * scope; module level spans the file. Everything comes from the index, never from source text.
	 *
	 * A blocker rather than a warning: this is known to break. Each one names the conflicting site
	 * and both ways out.
	 */
	protected renameCollisions(
		symbolId: string,
		newName: string,
		sites: ReadonlyMap<string, readonly RenameSite[]>,
		qualified: ReadonlySet<string>,
		inert: ReadonlySet<string>,
		context: ReadContext,
	): RenameBlocker[] {
		const renamed = context.declaration(symbolId);
		const owner = memberOwner(symbolId);
		const ownDeclaration = (module: string, site: RenameSite) =>
			owner !== null &&
			renamed?.module === module &&
			renamed.selectionRange !== undefined &&
			sameRange(site.range, renamed.selectionRange);
		const exposed = new Map<string, Position[]>();
		for (const [module, each] of sites) {
			const starts = each
				.filter((site) => {
					const key = startKey(module, site.range.start);
					return !ownDeclaration(module, site) && !qualified.has(key) && !inert.has(key);
				})
				.map((site) => site.range.start);
			exposed.set(module, starts);
		}
		const scopeOf = (declaration: StoredDeclaration) => context.ancestorsOf(declaration)[0]?.range ?? null;
		const collides = (other: StoredDeclaration) => {
			if (owner !== null && owner === memberOwner(other.symbolId)) return true;
			const scope = scopeOf(other);
			if ((exposed.get(other.module) ?? []).some((at) => scope === null || inside(scope, at))) return true;
			if (owner !== null || renamed === null) return false;
			const own = scopeOf(renamed);
			// Capture requires nested scopes.
			const nested = own !== null && (scope === null || (inside(scope, own.start) && inside(scope, own.end)));
			if (!nested || other.module !== renamed.module) return false;
			return context.referencesTo(other.symbolId).some((reference) => {
				const at = { line: reference.startLine, character: reference.startCharacter };
				return reference.module === renamed.module && reference.qualified !== true && inside(own, at);
			});
		};
		// Disjoint meanings never clash.
		const meaning = renamed === null ? undefined : this.meaningOf(renamed, context);
		const declared = context
			.declarationsNamed(newName)
			.filter(
				(other) =>
					other.symbolId !== symbolId &&
					sites.has(other.module) &&
					narrowed(meaning, this.meaningOf(other, context)) !== null &&
					collides(other),
			);

		// A rebinding import of the subject itself, its source token renamed, binds the same declaration again.
		const again = (entry: StoredImport) =>
			entry.conflict !== undefined &&
			entry.conflict.amongTransfers !== "exclude" &&
			entry.range !== undefined &&
			(sites.get(entry.module) ?? []).some((site) => sameRange(site.range, entry.range as Range));
		const bound = context
			.importsBinding(newName)
			.filter((entry) => (exposed.get(entry.module) ?? []).length > 0 && !again(entry));

		const concerns: RenameBlocker[] = [];
		if (declared.length > 0) {
			concerns.push({
				kind: "NameTaken",
				detail: nameAlreadyDeclared(newName, declared.length),
				sites: declared.map((other) => ({
					module: other.module,
					line: (other.selectionRange ?? other.range).start.line + 1,
				})),
			});
		}
		if (bound.length > 0) {
			concerns.push({
				kind: "NameImported",
				detail: nameAlreadyImported(newName, bound.length),
				sites: bound.map((entry) => ({
					module: entry.module,
					line: (entry.localRange ?? entry.range ?? entry.span).start.line + 1,
				})),
			});
		}
		return concerns;
	}

	/** The meaning a declaration's own export states; absent when none does. */
	private meaningOf(declaration: StoredDeclaration, context: ReadContext): Meaning | undefined {
		const edge = context
			.exportsIn(declaration.module)
			.find((each) => each.target.kind === "symbol" && each.target.symbolId === declaration.symbolId);
		return edge?.meaning;
	}
}
