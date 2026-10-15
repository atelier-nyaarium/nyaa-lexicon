import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { type BoundedTimer, runBounded, systemTimer } from "../protocol/src/boundedChild.js";
import { DIST_DIR } from "./dist";

export const ENTRYPOINTS = [
	{ source: path.join("adapters", "mcp", "src", "main.ts"), out: "main.js" },
	{ source: path.join("protocol", "src", "conformance", "cli.ts"), out: "conformance.js" },
	{ source: path.join("core", "src", "indexCli.ts"), out: "index-workspace.js" },
	{ source: path.join("core", "src", "gradeCli.ts"), out: "grade.js" },
	{ source: path.join("core", "src", "daemonCli.ts"), out: "daemon.js" },
	{ source: path.join("adapters", "lsp", "src", "main.ts"), out: "lsp.js" },
];

export const SMOKE_FAILURE = "failed to start";

interface ReleaseTimerHandle {
	timeout: unknown;
	onInterrupt: () => void;
}

export const releaseTimer: BoundedTimer = {
	set: (fn, ms): ReleaseTimerHandle => {
		let fired = false;
		const onInterrupt = (): void => {
			if (fired) return;
			fired = true;
			fn();
		};
		const timeout = systemTimer.set(onInterrupt, ms);
		process.on("SIGINT", onInterrupt);
		return { timeout, onInterrupt };
	},
	clear: (value): void => {
		const handle = value as ReleaseTimerHandle;
		systemTimer.clear(handle.timeout);
		process.off("SIGINT", handle.onInterrupt);
	},
};

export interface ProviderBundle {
	source: string;
	out: string;
	assets: string;
}

export function providerBundles(root: string): ProviderBundle[] {
	const directory = path.join(root, "providers");
	if (!existsSync(directory)) return [];

	return readdirSync(directory, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(path.join(directory, entry.name, "src", "main.ts")))
		.map((entry) => ({
			source: path.join("providers", entry.name, "src", "main.ts"),
			out: path.join("providers", entry.name, "main.js"),
			assets: path.join("providers", entry.name, "src"),
		}));
}

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

function readsAmd(node: ts.Node): boolean {
	if (ts.isPropertyAccessExpression(node)) {
		return ts.isIdentifier(node.expression) && node.expression.text === "define" && node.name.text === "amd";
	}
	if (ts.isElementAccessExpression(node)) {
		return (
			ts.isIdentifier(node.expression) &&
			node.expression.text === "define" &&
			stringValue(node.argumentExpression) === "amd"
		);
	}
	return false;
}

export function hasUmdWrapper(text: string): boolean {
	const source = ts.createSourceFile("bundle.js", text, ts.ScriptTarget.ESNext, false, ts.ScriptKind.JS);
	const pending: ts.Node[] = [source];
	for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
		if (readsAmd(node)) return true;
		ts.forEachChild(node, (child) => {
			pending.push(child);
		});
	}
	return false;
}

export function checkBundlesAreSelfContained(root: string): number {
	const bundles: string[] = [];
	function visit(directory: string): void {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const absolute = path.join(directory, entry.name);
			if (entry.isDirectory()) visit(absolute);
			else if (entry.name.endsWith(".js")) bundles.push(absolute);
		}
	}
	visit(path.join(root, DIST_DIR));

	for (const bundle of bundles) {
		if (hasUmdWrapper(readFileSync(bundle, "utf8"))) {
			throw new Error(
				`${path.relative(root, bundle)} ${SMOKE_FAILURE}: it carries a UMD wrapper, whose inner requires resolve against dist/`,
			);
		}
	}
	if (bundles.length === 0) throw new Error("no bundles found to check; the sweep would report clean over nothing");
	return bundles.length;
}

function failureDetail(result: Awaited<ReturnType<typeof runBounded>>): string {
	if (result.kind === "spawnFailed") return result.error.message;
	if (result.kind === "timedOut") return "timed out";
	if (result.kind === "overflowed") return "output exceeded the smoke limit";
	return `exit ${result.code}`;
}

export async function smokeProviders(root: string, providers: Array<{ out: string }>): Promise<void> {
	for (const entry of providers) {
		const bundle = path.join(root, DIST_DIR, entry.out);
		const probe = await runBounded(process.execPath, [bundle], {
			cwd: root,
			input: "",
			maxBytes: 1024 * 1024,
			timeoutMs: 20_000,
			timer: releaseTimer,
		});
		const complaint = probe.kind === "exited" ? probe.stderr.toString("utf8").trim() : "";
		if (probe.kind !== "exited" || probe.code !== 0 || complaint !== "") {
			const lines = complaint.split("\n").map((line) => line.trim());
			const reason = lines.find((line) => /^[A-Za-z]*Error:/.test(line)) ?? lines[0] ?? "";
			const detail = reason.slice(0, 200) || failureDetail(probe);
			throw new Error(`${entry.out} ${SMOKE_FAILURE}: ${detail}`);
		}
		console.log(`smoke ok ${entry.out}`);
	}
}

export async function smokeIsolation(root: string): Promise<void> {
	const result = await runBounded(process.execPath, [path.join(root, "scripts", "isolationSmoke.ts")], {
		cwd: root,
		maxBytes: 4 * 1024 * 1024,
		timeoutMs: 180_000,
		timer: releaseTimer,
	});
	if (result.kind === "exited") {
		process.stdout.write(result.stdout);
		process.stderr.write(result.stderr);
	}
	if (result.kind !== "exited" || result.code !== 0) {
		const why = result.kind === "exited" ? `exit ${result.code}` : failureDetail(result);
		console.error(`\nthe isolation smoke failed: ${why}`);
		throw new Error(`the isolation smoke failed: ${why}`);
	}
}
