import type { ImportResolution, Landing } from "@nyaa-lexicon/protocol";
import { pathSegments } from "../project.js";
import type { Place } from "../scopes.js";
import { isRustPathHead } from "../vocabulary.js";
import { PROVIDER_ID, RustQueryService } from "./context.js";

export class RustImportQueryService extends RustQueryService {
	/**
	 * Where a specifier's names are looked up, from a module's top, through the module tree its crate's
	 * declarations build: what a glob opens, what holds a named leaf, or the crate a lone segment binds.
	 */
	resolveImport(params: { fromModule: string; specifier: string }): ImportResolution {
		const { absolute, segments, glob } = pathSegments(params.specifier);
		if (segments.length === 0)
			return { status: "unresolved", reason: "ParseError", detail: "the import path is empty" };
		const facts = this.factsForModule(params.fromModule);
		const missing: ImportResolution = {
			status: "unresolved",
			reason: "NotIndexed",
			detail: `nothing indexed matched ${params.specifier}`,
		};
		if (facts === null) return missing;
		const site = { containerId: undefined, offset: -1 };
		const name = segments.at(-1) as string;
		const whole = glob || segments.length === 1;
		const external = this.scopes.externalHead(facts, segments, site, absolute);
		if (external !== undefined) return { status: "external", packageName: external };
		const placed = this.scopes.place(facts, whole ? segments : segments.slice(0, -1), site, [], absolute);
		if (placed === undefined || placed === null) {
			// Through this file's own import of an outside crate, such as `extern crate` or the import itself.
			const head = segments[0] as string;
			const root: Place = { facts, path: [], kind: "module" };
			const crate = absolute || isRustPathHead(head) ? undefined : this.scopes.externalImport(root, head);
			return crate === undefined ? missing : { status: "external", packageName: crate };
		}
		if (
			!whole &&
			this.scopes.itemsIn(placed, name).length === 0 &&
			this.scopes.externalImport(placed, name) === undefined
		)
			return missing;
		const landing = this.landingAt(placed);
		return landing === undefined ? missing : { status: "resolved", landing };
	}

	/** A file module lands on its file; an inline module or a type on its own scope. */
	private landingAt(place: Place): Landing | undefined {
		const raw = place.raw;
		if (raw === undefined)
			return place.kind === "module" ? { kind: "module", module: place.facts.module } : undefined;
		if (raw.fileModule !== undefined) {
			const file = this.scopes.moduleFileName(place);
			return file === undefined ? undefined : { kind: "module", module: file };
		}
		const scopeId = raw.declaration.symbolId;
		return { kind: "symbolScope", providerId: PROVIDER_ID, scopeId, anchorSymbolId: scopeId };
	}
}
