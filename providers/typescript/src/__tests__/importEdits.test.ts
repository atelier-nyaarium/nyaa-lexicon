import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyEdits, type ImportEditsResponse } from "@nyaa-lexicon/protocol";
import { harness } from "./harness.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const HOSTS = "export function host() {}\nexport function other() {}\nexport interface Host {}\n";

/**
 * The handed text with the planned import of `name` from src/hosts.ts, else the answer. The file on
 * disk holds `disk`, so the handed text must win.
 */
async function imported(
	text: string,
	o: { name?: string; module?: string; hosts?: string; disk?: string } = {},
): Promise<string | ImportEditsResponse> {
	const module = o.module ?? "src/use.ts";
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-typescript-import-"));
	roots.push(root);
	for (const [file, body] of Object.entries({ "src/hosts.ts": o.hosts ?? HOSTS, [module]: o.disk ?? text })) {
		mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		writeFileSync(path.join(root, file), body);
	}
	const provider = harness();
	provider.initialize(root);
	const answer = await provider.handlers.importEdits({
		module,
		text,
		name: o.name ?? "host",
		fromModule: "src/hosts.ts",
	});
	provider.shutdown();
	if (answer.status !== "planned") return answer;
	const result = applyEdits(text, answer.edits);
	return "problem" in result ? result.problem : result.text;
}

it("places the import past a header comment, after a directive, into an import of the same module, and from a nested folder", async () => {
	expect([
		await imported("// Header.\n\nhost();\n"),
		await imported('"use client";\n\nhost();\n'),
		await imported('import { other } from "./hosts";\n\nother(host());\n'),
		await imported("host();\n", { module: "src/deep/use.ts" }),
	]).toEqual([
		'// Header.\n\nimport { host } from "./hosts";\n\nhost();\n',
		'"use client";\nimport { host } from "./hosts";\n\nhost();\n',
		'import { other, host } from "./hosts";\n\nother(host());\n',
		'import { host } from "../hosts";\n\nhost();\n',
	]);
});

it("writes the form the module exports: a default, an alias, a type", async () => {
	expect([
		await imported("host();\n", { hosts: "export default function host() {}\n" }),
		await imported("host();\n", { hosts: "function host() {}\nexport { host as makeHost };\n" }),
		await imported("let h: Host;\n", { name: "Host" }),
	]).toEqual([
		'import host from "./hosts";\n\nhost();\n',
		'import { makeHost as host } from "./hosts";\n\nhost();\n',
		'import type { Host } from "./hosts";\n\nlet h: Host;\n',
	]);
});

it("plans against the handed text, answers present for the same binding, and refuses what it cannot bind", async () => {
	expect([
		await imported("host();\n", { disk: 'import { host } from "./hosts";\nhost();\n' }),
		await imported('import { host } from "./hosts";\nhost();\n'),
		await imported("const host = 1;\nhost;\n"),
		await imported("host();\n", { hosts: "export const x = 1;\nfunction host() {}\n" }),
		await imported("host(;\n"),
		// A type has no value to call.
		await imported("Host();\n", { name: "Host" }),
	]).toMatchObject([
		'import { host } from "./hosts";\n\nhost();\n',
		{ status: "present" },
		{ status: "refused", reason: "TargetCollision" },
		{ status: "refused", reason: "NotExported" },
		{ status: "refused", reason: "ParseError" },
		{ status: "refused", reason: "NotExported" },
	]);
});
