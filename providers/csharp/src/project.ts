// C# projects: each project file's one build context, like an IDE's, and the symbols it defines.
//
// A context is the Debug configuration and the project's first target framework. Its symbols are
// what MSBuild would pass the compiler: DefineConstants through Directory.Build.props, the project
// and the workspace files they import, then the SDK's configuration and framework symbols.

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseXmlDocument, type XmlContent, type XmlElement } from "@nyaa-lexicon/formats/xml";
import {
	coordinatesOf,
	type Diagnostic,
	hashContent,
	type ReadPolicy,
	type TextCoordinates,
} from "@nyaa-lexicon/protocol";
import { defineSymbols, evaluateCondition, expand, frameworkSymbols, unescaped } from "./msbuild.js";

////////////////////////////////
//  Interfaces & Types

export interface CsharpContext {
	/** The project file, workspace-relative. */
	project: string;
	targetFramework?: string;
	symbols: readonly string[];
}

export interface CsharpProjectState {
	/** By project directory, workspace-relative, "" for the root. */
	contexts: ReadonlyMap<string, CsharpContext>;
}

export interface DiscoveredContexts {
	state: CsharpProjectState;
	/** Every file read beside the project files, and every one looked for and absent. */
	consulted: string[];
	diagnostics: Diagnostic[];
	/** Each project directory's symbols: moves whenever some file's do. */
	fingerprint: string;
}

interface SourceFile {
	root: XmlElement;
	text: string;
	/** Built for the first warning in it. */
	coordinates?: TextCoordinates;
}

////////////////////////////////
//  Constants

const DIRECTORY_PROPS = "Directory.Build.props";

/** Properties a context's symbols come from; skipping one is worth a warning. */
const SYMBOL_PROPERTIES = new Set(["defineconstants", "targetframework", "targetframeworks"]);

/** Imports from the toolset or an SDK, which live outside the workspace. */
const TOOLSET = /\$\((?:MSBuildExtensionsPath\w*|MSBuildToolsPath\w*|MSBuildBinPath|MSBuildSDKsPath|VSToolsPath)\)/iu;

/** A property function finding the next Directory.Build.props above. */
const PARENT_PROPS = /GetPathOfFileAbove|GetDirectoryNameOfFileAbove/u;

/** Imports nest no deeper; a chain past it keeps what it read to there. */
const IMPORT_DEPTH = 64;

export const EMPTY_PROJECT_STATE: CsharpProjectState = { contexts: new Map() };

////////////////////////////////
//  Functions & Helpers

function attribute(element: XmlElement, name: string): string | undefined {
	return element.attributes.find((item) => item.name === name)?.value;
}

function elements(children: readonly XmlContent[]): XmlElement[] {
	return children.filter((child): child is XmlElement => child.type === "element");
}

function textOf(element: XmlElement): string {
	return element.children
		.map((child) => (child.type === "text" || child.type === "cdata" ? child.text : ""))
		.join("")
		.trim();
}

/** Whether a subtree assigns a property symbols come from. */
function setsSymbols(element: XmlElement): boolean {
	return elements(element.children).some(
		(child) => SYMBOL_PROPERTIES.has(child.name.toLowerCase()) || setsSymbols(child),
	);
}

/** The workspace-relative directory of a workspace-relative file, "" at the root. */
function directoryOf(file: string): string {
	const at = file.lastIndexOf("/");
	return at < 0 ? "" : file.slice(0, at);
}

/** MSBuild's reserved properties about a file, `Project` for the project's and `ThisFile` for the one being read. */
function reservedPaths(prefix: "Project" | "ThisFile", absolute: string): [string, string][] {
	const name = `msbuild${prefix.toLowerCase()}`;
	const extension = path.extname(absolute);
	const directory = path.dirname(absolute);
	// A project's directory has no trailing separator; the file being read's does.
	const shown = prefix === "Project" ? directory : `${directory}${path.sep}`;
	const directoryName = prefix === "Project" ? "msbuildprojectdirectory" : "msbuildthisfiledirectory";
	return [
		[prefix === "Project" ? "msbuildprojectfile" : "msbuildthisfile", path.basename(absolute)],
		[`${name}name`, path.basename(absolute, extension)],
		[`${name}extension`, extension],
		[`${name}fullpath`, absolute],
		[directoryName, shown],
		[`${directoryName}noroot`, shown.slice(path.parse(directory).root.length)],
	];
}

function isSdkProject(root: XmlElement): boolean {
	return attribute(root, "Sdk") !== undefined || elements(root.children).some((child) => child.name === "Sdk");
}

////////////////////////////////
//  Classes

/** Reads project files once per discovery and keeps what their evaluations warn about. */
class ProjectReader {
	readonly diagnostics: Diagnostic[] = [];
	readonly reads = new Set<string>();
	/** Paths looked for, present or not, so one appearing later is noticed. */
	readonly probed = new Set<string>();
	private readonly sources = new Map<string, SourceFile | undefined>();
	private readonly warned = new Set<string>();
	/** The nearest Directory.Build.props by directory. */
	private readonly nearest = new Map<string, string | undefined>();

	constructor(
		readonly root: string,
		private readonly policy: ReadPolicy,
	) {}

	/** A workspace file's document; undefined when it is missing, denied or not XML. */
	source(file: string): SourceFile | undefined {
		if (this.sources.has(file)) return this.sources.get(file);
		const read = this.load(file);
		this.sources.set(file, read);
		return read;
	}

	/** A workspace-relative path for an absolute one inside the workspace. */
	relative(absolute: string): string | undefined {
		const relative = path.relative(this.root, absolute).split(path.sep).join("/");
		return relative.startsWith("..") || path.isAbsolute(relative) ? undefined : relative;
	}

	/** The nearest Directory.Build.props at or above a directory, inside the workspace. */
	directoryProps(directory: string | undefined): string | undefined {
		if (directory === undefined) return undefined;
		if (this.nearest.has(directory)) return this.nearest.get(directory);
		// Each directory up to the root, then each's answer from the nearest above.
		const walked: string[] = [];
		let current: string | undefined = directory;
		while (current !== undefined && !this.nearest.has(current)) {
			walked.push(current);
			current = current === "" ? undefined : directoryOf(current);
		}
		let found = current === undefined ? undefined : this.nearest.get(current);
		for (const item of walked.reverse()) {
			const candidate = item === "" ? DIRECTORY_PROPS : `${item}/${DIRECTORY_PROPS}`;
			this.probed.add(candidate);
			if (this.isFile(candidate)) found = candidate;
			this.nearest.set(item, found);
		}
		return found;
	}

	isFile(file: string): boolean {
		const absolute = path.join(this.root, file);
		return existsSync(absolute) && statSync(absolute).isFile();
	}

	warn(file: string, element: XmlElement, message: string): void {
		const source = this.sources.get(file);
		if (source !== undefined) source.coordinates ??= coordinatesOf(source.text);
		const range = source?.coordinates?.rangeAt(element.pos, element.startTagEnd);
		const key = `${file}:${element.pos}:${message}`;
		if (this.warned.has(key)) return;
		this.warned.add(key);
		this.diagnostics.push({ severity: "warning", message, path: file, ...(range === undefined ? {} : { range }) });
	}

	private load(file: string): SourceFile | undefined {
		const absolute = path.join(this.root, file);
		if (!this.isFile(file) || !this.policy.readable(absolute)) return undefined;
		const text = readFileSync(absolute, "utf8");
		const parsed = parseXmlDocument(text);
		if (parsed.document === undefined) {
			const at = coordinatesOf(text).positionAt(parsed.problem.pos);
			this.diagnostics.push({
				severity: "warning",
				message: `${file} is not well-formed XML, so it adds no preprocessor symbols: ${parsed.problem.message}`,
				path: file,
				...(at === undefined ? {} : { range: { start: at, end: at } }),
			});
			return undefined;
		}
		return { root: parsed.document.root, text };
	}
}

/** One pass over a project and what it imports, with some properties fixed from outside. */
class Evaluation {
	private readonly properties = new Map<string, string>();
	private readonly globals: ReadonlySet<string>;
	private readonly imported = new Set<string>();
	private depth = 0;

	constructor(
		private readonly reader: ProjectReader,
		private readonly project: string,
		globals: Readonly<Record<string, string>>,
	) {
		for (const [name, value] of Object.entries(globals)) this.properties.set(name.toLowerCase(), value);
		this.globals = new Set(this.properties.keys());
	}

	value(name: string): string {
		return this.properties.get(name.toLowerCase()) ?? "";
	}

	run(root: XmlElement): void {
		this.imported.add(this.project);
		const sdk = isSdkProject(root);
		if (sdk) this.sdkProps();
		this.walk(root.children, this.project);
		if (sdk) this.sdkTargets();
	}

	private set(name: string, value: string): void {
		const key = name.toLowerCase();
		if (!this.globals.has(key)) this.properties.set(key, value);
	}

	private append(symbols: readonly string[]): void {
		const current = this.value("DefineConstants");
		this.set("DefineConstants", [current, ...symbols].filter((item) => item !== "").join(";"));
	}

	/** Directory.Build.props, then the SDK's own defaults and TRACE, before the project body. */
	private sdkProps(): void {
		this.commonProps();
		if (this.value("Platform") === "") this.set("Platform", "AnyCPU");
		this.append(["TRACE"]);
	}

	/** What the toolset's common props import: Directory.Build.props, unless a property turns it off. */
	private commonProps(): void {
		if (this.value("ImportDirectoryBuildProps").toLowerCase() !== "false")
			this.importProps(directoryOf(this.project));
	}

	/** The configuration's symbol and the framework's, after the project body. */
	private sdkTargets(): void {
		if (this.value("DisableImplicitConfigurationDefines").toLowerCase() !== "true")
			this.append([this.value("Configuration").toUpperCase().replace(/[-. ]/gu, "_")]);
		if (this.value("DisableImplicitFrameworkDefines").toLowerCase() !== "true")
			this.append(frameworkSymbols(unescaped(this.value("TargetFramework"))));
	}

	/** Properties by name, with MSBuild's reserved ones about the project and the file being read. */
	private lookup(file: string): (name: string) => string {
		const reserved = new Map([
			...reservedPaths("Project", path.join(this.reader.root, this.project)),
			...reservedPaths("ThisFile", path.join(this.reader.root, file)),
		]);
		return (name) => reserved.get(name.toLowerCase()) ?? this.value(name);
	}

	/** Whether an element's condition holds; undefined when it is not one comparison or `Exists`. */
	private holds(element: XmlElement, file: string): boolean | undefined {
		const condition = attribute(element, "Condition");
		if (condition === undefined) return true;
		const lookup = this.lookup(file);
		return evaluateCondition(condition, lookup, (written) => {
			// The toolset stands where the SDK does.
			if (TOOLSET.test(written)) return true;
			const target = this.resolve(written, file);
			if (target === undefined) return undefined;
			this.reader.probed.add(target);
			return this.reader.isFile(target);
		});
	}

	/** A condition that holds; one too complex to read skips its element, with a warning when it may carry symbols. */
	private admits(element: XmlElement, file: string, carriesSymbols: boolean): boolean {
		const holds = this.holds(element, file);
		if (holds === undefined && carriesSymbols)
			this.reader.warn(
				file,
				element,
				`Skipped a <${element.name}> whose condition is not one comparison, so its preprocessor symbols are not read: ${attribute(element, "Condition")}`,
			);
		return holds === true;
	}

	private walk(children: readonly XmlContent[], file: string): void {
		for (const child of elements(children)) {
			if (child.name === "PropertyGroup") this.propertyGroup(child, file);
			else if (child.name === "Choose") this.choose(child, file);
			else if (child.name === "Import") this.importElement(child, file);
			else if (child.name === "ImportGroup" && this.admits(child, file, true)) this.walk(child.children, file);
		}
	}

	private propertyGroup(group: XmlElement, file: string): void {
		if (!this.admits(group, file, setsSymbols(group))) return;
		for (const property of elements(group.children)) {
			const symbolic = SYMBOL_PROPERTIES.has(property.name.toLowerCase());
			if (!this.admits(property, file, symbolic)) continue;
			const expanded = expand(textOf(property), this.lookup(file));
			if (!expanded.complete && symbolic)
				this.reader.warn(file, property, `Dropped a function or item reference from <${property.name}>`);
			this.set(property.name, expanded.value);
		}
	}

	private choose(choose: XmlElement, file: string): void {
		for (const branch of elements(choose.children)) {
			if (branch.name === "Otherwise") {
				this.walk(branch.children, file);
				return;
			}
			if (branch.name !== "When") continue;
			const holds = this.holds(branch, file);
			if (holds === undefined) {
				this.admits(branch, file, setsSymbols(choose));
				return;
			}
			if (holds) {
				this.walk(branch.children, file);
				return;
			}
		}
	}

	private importElement(element: XmlElement, file: string): void {
		if (!this.admits(element, file, true)) return;
		const project = attribute(element, "Project") ?? "";
		if (attribute(element, "Sdk") !== undefined) {
			if (/Sdk\.props$/iu.test(project)) this.sdkProps();
			else if (/Sdk\.targets$/iu.test(project)) this.sdkTargets();
			return;
		}
		if (TOOLSET.test(project)) {
			// A legacy project reaches Directory.Build.props through the toolset's common props.
			if (/Microsoft\.Common\.props$/iu.test(project)) this.commonProps();
			return;
		}
		if (PARENT_PROPS.test(project) && project.includes(DIRECTORY_PROPS)) {
			this.importProps(directoryOf(file) === "" ? undefined : directoryOf(directoryOf(file)), element, file);
			return;
		}
		const target = this.resolve(project, file);
		if (target === undefined) {
			this.reader.warn(file, element, `Skipped an import it cannot resolve inside the workspace: ${project}`);
			return;
		}
		this.importFile(target, element, file);
	}

	/** A path in an import, workspace-relative; undefined when it holds a function or wildcard, or leaves the workspace. */
	private resolve(written: string, file: string): string | undefined {
		const expanded = expand(written, this.lookup(file));
		if (!expanded.complete || expanded.value.includes("*")) return undefined;
		const base = path.join(this.reader.root, directoryOf(file));
		return this.reader.relative(path.resolve(base, unescaped(expanded.value).replaceAll("\\", "/")));
	}

	private importProps(directory: string | undefined, element?: XmlElement, from?: string): void {
		const props = this.reader.directoryProps(directory);
		if (props !== undefined) this.importFile(props, element, from);
	}

	private importFile(file: string, element?: XmlElement, from?: string): void {
		// MSBuild imports a file once per evaluation.
		if (this.imported.has(file)) return;
		if (this.depth >= IMPORT_DEPTH) {
			if (element !== undefined && from !== undefined)
				this.reader.warn(from, element, `Imports nest deeper than ${IMPORT_DEPTH}; ${file} is not read`);
			return;
		}
		this.imported.add(file);
		const source = this.reader.source(file);
		if (source === undefined) {
			this.reader.probed.add(file);
			return;
		}
		this.reader.reads.add(file);
		this.depth++;
		try {
			this.walk(source.root.children, file);
		} finally {
			this.depth--;
		}
	}
}

////////////////////////////////
//  Main

/** One project's context: the first target framework, and the Debug configuration. */
function contextOf(reader: ProjectReader, project: string): CsharpContext {
	const source = reader.source(project);
	if (source === undefined) return { project, symbols: [] };
	const evaluate = (globals: Record<string, string>) => {
		const evaluation = new Evaluation(reader, project, globals);
		evaluation.run(source.root);
		return evaluation;
	};
	const first = evaluate({ Configuration: "Debug" });
	const single = unescaped(first.value("TargetFramework")).trim();
	const listed = unescaped(first.value("TargetFrameworks"))
		.split(";")
		.map((item) => item.trim())
		.filter((item) => item !== "");
	// A multi-targeted project builds each framework with it fixed from outside.
	const chosen = single === "" ? listed[0] : single;
	const final =
		single === "" && chosen !== undefined ? evaluate({ Configuration: "Debug", TargetFramework: chosen }) : first;
	return {
		project,
		...(chosen === undefined ? {} : { targetFramework: chosen }),
		symbols: defineSymbols(final.value("DefineConstants")),
	};
}

/** Every project's context, a file's being its nearest project's. */
export function discoverContexts(root: string, projects: readonly string[], policy: ReadPolicy): DiscoveredContexts {
	const reader = new ProjectReader(root, policy);
	const contexts = new Map<string, CsharpContext>();
	for (const project of [...projects].sort()) {
		const directory = directoryOf(project);
		const context = contextOf(reader, project);
		const held = contexts.get(directory);
		if (held === undefined) {
			contexts.set(directory, context);
			continue;
		}
		const source = reader.source(project);
		if (source !== undefined)
			reader.warn(
				project,
				source.root,
				`Shares its directory with ${held.project}, whose symbols its files read with`,
			);
	}
	const fingerprint = hashContent(
		JSON.stringify([...contexts].map(([directory, context]) => [directory, context.symbols])),
	);
	return {
		state: { contexts },
		consulted: [...new Set([...reader.reads, ...reader.probed])].sort(),
		diagnostics: reader.diagnostics,
		fingerprint,
	};
}

/** The context of the project whose directory holds a module most closely. */
export function contextFor(state: CsharpProjectState, module: string): CsharpContext | undefined {
	const segments = module.split("/").slice(0, -1);
	for (let length = segments.length; length >= 0; length--) {
		const context = state.contexts.get(segments.slice(0, length).join("/"));
		if (context !== undefined) return context;
	}
	return undefined;
}
