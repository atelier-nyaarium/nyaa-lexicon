////////////////////////////////
//  Reading source structurally, for the residues that need more than a token
//
//  A sweep asking "does this identifier appear" is a token predicate over flat text, which
//  `docs/parsing.md` rule 4 permits and `residue.ts` serves. A sweep asking whether a call REACHES a
//  capability is a different question: the same spelling can be an import, a local, an injected
//  parameter or a property, and text cannot tell them apart.
//
//  Imported ONLY by tests, through the `./ast` subpath, so `typescript` never reaches a bundle.

import ts from "typescript";

////////////////////////////////
//  Interfaces & Types

/** One file, parsed once, with the path a report should name. */
export interface ParsedSource {
	readonly file: string;
	readonly source: ts.SourceFile;
}

////////////////////////////////
//  Functions & Helpers

export function parseSource(file: string, text: string): ParsedSource {
	return { file, source: ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true) };
}

function specifierOf(statement: ts.Statement): string | undefined {
	if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return undefined;
	return statement.moduleSpecifier.text;
}

/**
 * Local names an import BINDS to one of `exported`, from any of `modules`.
 *
 * The binding is the question, never the spelling: `readFileSync as slurp` is caught, and a
 * `readFile` handed in as a parameter is not, because nothing imported it.
 */
export function importedAs(
	source: ts.SourceFile,
	modules: ReadonlySet<string>,
	exported: ReadonlySet<string>,
): Set<string> {
	const local = new Set<string>();
	for (const statement of source.statements) {
		const specifier = specifierOf(statement);
		if (specifier === undefined || !modules.has(specifier)) continue;
		const bindings = (statement as ts.ImportDeclaration).importClause?.namedBindings;
		if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
		for (const element of bindings.elements) {
			if (exported.has((element.propertyName ?? element.name).text)) local.add(element.name.text);
		}
	}
	return local;
}

/** Local names bound to a whole module, whether `import fs from` or `import * as fs from`. */
export function namespacesOf(source: ts.SourceFile, modules: ReadonlySet<string>): Set<string> {
	const local = new Set<string>();
	for (const statement of source.statements) {
		const specifier = specifierOf(statement);
		if (specifier === undefined || !modules.has(specifier)) continue;
		const clause = (statement as ts.ImportDeclaration).importClause;
		if (clause?.name !== undefined) local.add(clause.name.text);
		if (clause?.namedBindings !== undefined && ts.isNamespaceImport(clause.namedBindings)) {
			local.add(clause.namedBindings.name.text);
		}
	}
	return local;
}

/** Every module specifier this file imports, however it imports it. */
export function importSpecifiers(source: ts.SourceFile): string[] {
	return source.statements.map(specifierOf).filter((specifier): specifier is string => specifier !== undefined);
}

/** Every call under `root`, which may be a whole file or one handler's subtree. */
export function callsIn(root: ts.Node): ts.CallExpression[] {
	const found: ts.CallExpression[] = [];
	const walk = (node: ts.Node): void => {
		if (ts.isCallExpression(node)) found.push(node);
		ts.forEachChild(node, walk);
	};
	walk(root);
	return found;
}

/** The receiver and member a call reaches, so `fs.readFileSync` and `fs["readFileSync"]` read alike. */
export function calleeOf(node: ts.CallExpression): { receiver?: string; name: string } | undefined {
	const target = node.expression;
	if (ts.isIdentifier(target)) return { name: target.text };
	if (ts.isPropertyAccessExpression(target)) {
		const receiver = ts.isIdentifier(target.expression) ? target.expression.text : undefined;
		return receiver === undefined ? { name: target.name.text } : { receiver, name: target.name.text };
	}
	if (ts.isElementAccessExpression(target) && ts.isStringLiteral(target.argumentExpression)) {
		const receiver = ts.isIdentifier(target.expression) ? target.expression.text : undefined;
		return receiver === undefined
			? { name: target.argumentExpression.text }
			: { receiver, name: target.argumentExpression.text };
	}
	return undefined;
}

/** Names a scope introduces: its parameters, and the locals declared directly in it. */
function boundIn(scope: ts.Node): Set<string> {
	const names = new Set<string>();
	const add = (name: ts.BindingName): void => {
		if (ts.isIdentifier(name)) names.add(name.text);
		else for (const element of name.elements) if (ts.isBindingElement(element)) add(element.name);
	};
	if (ts.isFunctionLike(scope)) for (const parameter of scope.parameters) add(parameter.name);
	const walk = (node: ts.Node): void => {
		// Never descend into a nested scope: its declarations are not this one's.
		if (node !== scope && (ts.isFunctionLike(node) || ts.isClassLike(node))) return;
		if (ts.isVariableDeclaration(node)) add(node.name);
		if (ts.isFunctionDeclaration(node) && node.name !== undefined) names.add(node.name.text);
		ts.forEachChild(node, walk);
	};
	walk(scope);
	return names;
}

/**
 * Whether a NEARER declaration than the tracked one owns this name at `node`.
 *
 * Without this a parameter called `readFileSync` reads as the imported one, which reports a module
 * for reaching a capability it never touched. `origin` is where the tracked name was bound, so the
 * scope holding it is the defining scope rather than a shadow: a local rebinding is exactly what
 * makes the name reach, and treating its own declaration as a shadow would hide every one.
 */
export function shadowed(node: ts.Node, name: string, origin?: ts.Node): boolean {
	for (let scope = node.parent; scope !== undefined; scope = scope.parent) {
		if (ts.isSourceFile(scope)) return false;
		if (!ts.isFunctionLike(scope) && !ts.isBlock(scope) && !ts.isForStatement(scope)) continue;
		if (!boundIn(scope).has(name)) continue;
		const defining = origin !== undefined && origin.pos >= scope.pos && origin.end <= scope.end;
		if (!defining) return true;
	}
	return false;
}

/** The module a `require(...)` or an `import(...)` loads, when its specifier is written out. */
function loadedModule(node: ts.Node | undefined): string | undefined {
	if (node === undefined) return undefined;
	if (ts.isAwaitExpression(node)) return loadedModule(node.expression);
	if (!ts.isCallExpression(node)) return undefined;
	const callee = node.expression;
	const loader =
		(ts.isIdentifier(callee) && callee.text === "require") || callee.kind === ts.SyntaxKind.ImportKeyword;
	const argument = node.arguments[0];
	if (!loader || argument === undefined || !ts.isStringLiteral(argument)) return undefined;
	return argument.text;
}

/** The member a `ns.member` or `ns["member"]` names, when the receiver is one of `namespaces`. */
function memberOfNamespace(node: ts.Node, namespaces: ReadonlySet<string>): string | undefined {
	if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return undefined;
	if (!ts.isIdentifier(node.expression) || !namespaces.has(node.expression.text)) return undefined;
	if (ts.isPropertyAccessExpression(node)) return node.name.text;
	return ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : undefined;
}

function declarationsIn(source: ts.SourceFile): ts.VariableDeclaration[] {
	const found: ts.VariableDeclaration[] = [];
	const walk = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node)) found.push(node);
		ts.forEachChild(node, walk);
	};
	walk(source);
	return found;
}

/**
 * Names a local declaration rebinds to an already-bound one, to a fixed point.
 *
 * `const read = fs.readFileSync` and `const { readFileSync } = fs` both launder the binding out of
 * the import, and a chain of them launders it further, so this runs until nothing new appears.
 */
function rebound(
	source: ts.SourceFile,
	bare: Set<string>,
	namespaces: ReadonlySet<string>,
	members: ReadonlySet<string>,
	modulesLoaded: ReadonlySet<string>,
): Map<string, ts.Node | undefined> {
	const known = new Map<string, ts.Node | undefined>([...bare].map((name) => [name, undefined]));
	const declarations = declarationsIn(source);
	let growing = true;
	while (growing) {
		growing = false;
		for (const declaration of declarations) {
			const initializer = declaration.initializer;
			if (initializer === undefined) continue;
			// `const read = fs.readFileSync`, `fs["readFileSync"]`, `slurp`, or `fs.readFileSync.bind(fs)`
			if (ts.isIdentifier(declaration.name)) {
				const member = memberOfNamespace(initializer, namespaces);
				const boundFrom =
					ts.isCallExpression(initializer) &&
					ts.isPropertyAccessExpression(initializer.expression) &&
					INDIRECT.has(initializer.expression.name.text)
						? initializer.expression.expression
						: undefined;
				const reaches =
					(member !== undefined && members.has(member)) ||
					(ts.isIdentifier(initializer) && known.has(initializer.text)) ||
					(boundFrom !== undefined &&
						((ts.isIdentifier(boundFrom) && known.has(boundFrom.text)) ||
							members.has(memberOfNamespace(boundFrom, namespaces) ?? "")));
				if (reaches && !known.has(declaration.name.text)) {
					known.set(declaration.name.text, declaration);
					growing = true;
				}
				continue;
			}
			// `const { readFileSync } = fs`, and the same off a `require` or a dynamic import
			if (!ts.isObjectBindingPattern(declaration.name)) continue;
			const fromNamespace = ts.isIdentifier(initializer) && namespaces.has(initializer.text);
			if (!fromNamespace && !modulesLoaded.has(loadedModule(initializer) ?? "")) continue;
			for (const element of declaration.name.elements) {
				const named = element.propertyName ?? element.name;
				if (!ts.isIdentifier(named) || !members.has(named.text)) continue;
				if (!ts.isIdentifier(element.name) || known.has(element.name.text)) continue;
				known.set(element.name.text, declaration);
				growing = true;
			}
		}
	}
	return known;
}

/** `bind`, `call` and `apply` reach the function they are taken from, so the receiver is the target. */
const INDIRECT = new Set(["bind", "call", "apply"]);

/**
 * Everything REACHING one of `members` through an import, by any spelling.
 *
 * A call on an imported name, a member on a namespace bound to one of `modules`, an alias of either,
 * `bind`/`call`/`apply` on one, and a bare reference handed to something else: passing the function
 * on is reaching it, and a rule about who may touch a capability that stops at the call site is a
 * rule about syntax rather than about reach.
 *
 * A name a nearer scope owns is not reported, and neither is a same-named local or parameter, since
 * nothing imported those.
 *
 * Known limit: a local module RE-EXPORTING the capability hides it, since the specifier is then not
 * one of `modules`. Following that is `reExportedFrom`, which the caller opts into.
 */
export function reachedCalls(
	source: ts.SourceFile,
	modules: ReadonlySet<string>,
	members: ReadonlySet<string>,
): Array<{ call: ts.Node; name: string }> {
	// A `require` or a dynamic `import` binds the same module without an import declaration.
	const namespaces = new Set(namespacesOf(source, modules));
	for (const declaration of declarationsIn(source)) {
		if (!modules.has(loadedModule(declaration.initializer) ?? "")) continue;
		if (ts.isIdentifier(declaration.name)) namespaces.add(declaration.name.text);
	}
	const bare = rebound(source, importedAs(source, modules, members), namespaces, members, modules);
	const found: Array<{ call: ts.Node; name: string }> = [];
	const reaches = (node: ts.Node): string | undefined => {
		if (ts.isIdentifier(node)) {
			return bare.has(node.text) && !shadowed(node, node.text, bare.get(node.text)) ? node.text : undefined;
		}
		if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
			const member = ts.isPropertyAccessExpression(node)
				? node.name.text
				: ts.isStringLiteral(node.argumentExpression)
					? node.argumentExpression.text
					: undefined;
			if (member === undefined || !members.has(member)) return undefined;
			if (!ts.isIdentifier(node.expression) || !namespaces.has(node.expression.text)) return undefined;
			return shadowed(node.expression, node.expression.text) ? undefined : `${node.expression.text}.${member}`;
		}
		return undefined;
	};

	for (const call of callsIn(source)) {
		const direct = reaches(call.expression);
		if (direct !== undefined) {
			found.push({ call, name: direct });
			continue;
		}
		// `fs.readFileSync.bind(fs)` and its kin reach through one more hop.
		const callee = call.expression;
		if (ts.isPropertyAccessExpression(callee) && INDIRECT.has(callee.name.text)) {
			const target = reaches(callee.expression);
			if (target !== undefined) found.push({ call, name: `${target}.${callee.name.text}` });
		}
	}

	// A bare reference handed on rather than called: `paths.map(readFileSync)`.
	const walk = (node: ts.Node): void => {
		if (ts.isCallExpression(node)) {
			for (const argument of node.arguments) {
				const name = reaches(argument);
				if (name !== undefined) found.push({ call: argument, name: `${name} (passed on)` });
			}
		}
		ts.forEachChild(node, walk);
	};
	walk(source);
	return found;
}

/** Whether this file declares `name` itself, rather than importing it. */
export function declaresName(source: ts.SourceFile, name: string): boolean {
	let found = false;
	const walk = (node: ts.Node): void => {
		if (found) return;
		const named =
			(ts.isFunctionDeclaration(node) && node.name?.text === name) ||
			(ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) ||
			(ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) ||
			(ts.isClassDeclaration(node) && node.name?.text === name);
		if (named) found = true;
		ts.forEachChild(node, walk);
	};
	walk(source);
	return found;
}

/** The 1-based line a node starts on, for a report a reader can open. */
export function lineOf(parsed: ParsedSource, node: ts.Node): number {
	return parsed.source.getLineAndCharacterOfPosition(node.getStart(parsed.source)).line + 1;
}
