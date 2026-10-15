import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { callsIn, parseSource } from "../protocol/src/astResidue.js";
import { ENTRYPOINTS } from "./bundleSmoke";

export type BumpKind = "patch" | "minor" | "major";

export interface DerivedSite {
	file: string;
	key?: string;
	what: string;
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const PLUGIN_MANIFEST = path.join(".claude-plugin", "plugin.json");
const UNGUARDED_ENTRYPOINT = "conformance.js";

export const DERIVED_SITES: DerivedSite[] = [
	{
		file: path.join("adapters", "mcp", "src", "serve.ts"),
		key: "version",
		what: "the MCP server's declared version",
	},
	{
		file: path.join("core", "src", "version.ts"),
		what: "the build version a daemon stamps into its lock",
	},
	{
		file: path.join("client", "src", "version.ts"),
		what: "the build a client judges a daemon by when no install is known",
	},
];

function stringValue(node: ts.Expression | undefined): string | undefined {
	let at = node;
	while (
		at !== undefined &&
		(ts.isAsExpression(at) || ts.isSatisfiesExpression(at) || ts.isParenthesizedExpression(at))
	) {
		at = at.expression;
	}
	return at !== undefined && ts.isStringLiteralLike(at) ? at.text : undefined;
}

function propertyName(name: ts.PropertyName): string | undefined {
	return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

export function nextVersion(current: string, kind: BumpKind): string {
	const parts = SEMVER_RE.exec(current);
	if (!parts) throw new Error(`${current} is not a plain major.minor.patch version`);
	const [major, minor, patch] = parts.slice(1, 4).map(Number) as [number, number, number];
	if (kind === "major") return `${major + 1}.0.0`;
	if (kind === "minor") return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

function versionField(text: string): { start: number; end: number; value: string } {
	JSON.parse(text);
	const json = ts.parseJsonText("manifest.json", text);
	const top = json.statements[0]?.expression;
	const fields =
		top !== undefined && ts.isObjectLiteralExpression(top)
			? top.properties.filter(
					(property): property is ts.PropertyAssignment =>
						ts.isPropertyAssignment(property) && propertyName(property.name) === "version",
				)
			: [];
	if (fields.length !== 1) throw new Error(`expected exactly one "version" field, found ${fields.length}`);
	const literal = (fields[0] as ts.PropertyAssignment).initializer;
	if (!ts.isStringLiteral(literal)) throw new Error(`the "version" field is not a string`);
	return { start: literal.getStart(json), end: literal.end, value: literal.text };
}

export function setVersion(text: string, version: string): string {
	const field = versionField(text);
	return `${text.slice(0, field.start)}${JSON.stringify(version)}${text.slice(field.end)}`;
}

export function readVersion(text: string): string {
	return versionField(text).value;
}

export function expandWorkspaceEntry(root: string, entry: string): string[] {
	if (!entry.endsWith("/*")) {
		const file = path.join(entry, "package.json");
		if (!existsSync(path.join(root, file))) {
			throw new Error(`workspace "${entry}" has no package.json; this script's target list is out of date`);
		}
		return [file];
	}

	const dir = entry.slice(0, -2);
	if (!existsSync(path.join(root, dir))) {
		throw new Error(`workspace directory "${dir}" is gone; this script's target list is out of date`);
	}
	return readdirSync(path.join(root, dir), { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => path.join(dir, e.name, "package.json"))
		.filter((file) => existsSync(path.join(root, file)))
		.sort();
}

export function versionTargets(root: string): string[] {
	const rootManifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
		workspaces?: string[];
	};
	const workspaces = rootManifest.workspaces;
	if (!workspaces || workspaces.length === 0) {
		throw new Error("root package.json declares no workspaces; this script assumes a monorepo");
	}
	if (!existsSync(path.join(root, PLUGIN_MANIFEST))) {
		throw new Error(`${PLUGIN_MANIFEST} is gone; the marketplace reads it to decide what version is installed`);
	}
	return ["package.json", ...workspaces.flatMap((entry) => expandWorkspaceEntry(root, entry)), PLUGIN_MANIFEST];
}

function protocolMajorOf(text: string): string {
	const source = ts.createSourceFile("version.ts", text, ts.ScriptTarget.ESNext, false);
	for (const statement of source.statements) {
		if (!ts.isVariableStatement(statement)) continue;
		if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
		if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
		for (const declaration of statement.declarationList.declarations) {
			if (!ts.isIdentifier(declaration.name) || declaration.name.text !== "PROTOCOL_VERSION") continue;
			const major = SEMVER_RE.exec(stringValue(declaration.initializer) ?? "")?.[1];
			if (major !== undefined) return major;
		}
	}
	throw new Error("protocol/src/version.ts no longer states PROTOCOL_VERSION as a plain version");
}

export function checkProtocolRelease(root: string, kind: BumpKind, headVersionSource: string): void {
	const now = protocolMajorOf(readFileSync(path.join(root, "protocol", "src", "version.ts"), "utf8"));
	const before = protocolMajorOf(headVersionSource);
	if (now === before || kind === "major") return;
	throw new Error(
		`PROTOCOL_VERSION moved from major ${before} to ${now}, which breaks the wire, but this is a ${kind} release.\n` +
			`Ship it as a major, or restore the protocol version.`,
	);
}

function derivesVersion(root: string, site: DerivedSite): boolean {
	const file = path.resolve(root, site.file);
	const manifest = path.resolve(root, "package.json");
	const { source } = parseSource(file, readFileSync(file, "utf8"));
	const bindings = new Set<string>();
	for (const statement of source.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
		const name = statement.importClause?.name;
		if (name === undefined) continue;
		if (path.resolve(path.dirname(file), statement.moduleSpecifier.text) === manifest) bindings.add(name.text);
	}
	const reads = (node: ts.Node): boolean => {
		const read =
			ts.isPropertyAccessExpression(node) &&
			ts.isIdentifier(node.expression) &&
			bindings.has(node.expression.text) &&
			node.name.text === "version";
		if (read && site.key === undefined) return true;
		const parent = node.parent;
		if (read && ts.isPropertyAssignment(parent) && parent.initializer === node) {
			if (propertyName(parent.name) === site.key) return true;
		}
		return ts.forEachChild(node, reads) === true;
	};
	return reads(source);
}

export function checkDerivedSites(root: string): void {
	for (const site of DERIVED_SITES) {
		if (derivesVersion(root, site)) continue;
		const where = site.key === undefined ? "" : ` as the value of ${site.key}`;
		throw new Error(
			`${site.file} no longer derives ${site.what} from package.json (expected a read of its version${where}).\n` +
				`Either restore the derivation or add the file to this script's target list.`,
		);
	}
}

export function checkEntryGuards(root: string): void {
	for (const entry of ENTRYPOINTS) {
		if (entry.out === UNGUARDED_ENTRYPOINT) continue;
		const { source } = parseSource(entry.source, readFileSync(path.join(root, entry.source), "utf8"));
		const guarded = callsIn(source).some(
			(call) => ts.isIdentifier(call.expression) && call.expression.text === "refuseRuntime",
		);
		if (guarded) continue;
		throw new Error(
			`${entry.source} does not call refuseRuntime, so dist/${entry.out} would die on a builtin instead of naming the runtime it needs.`,
		);
	}
}
