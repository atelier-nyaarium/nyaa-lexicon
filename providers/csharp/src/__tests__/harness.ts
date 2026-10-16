import { afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SECRET_READERS } from "@nyaa-lexicon/formats/secret";
import { handlersFor, PROTOCOL_VERSION } from "@nyaa-lexicon/protocol";
import { secretWire } from "../../../../protocol/src/__tests__/secretWire.js";
import type { CsharpProvider } from "../main.js";

type CsharpHandlers = ReturnType<typeof handlersFor>;

const sessions = new WeakMap<CsharpProvider, CsharpHandlers>();

export function writeWorkspace(root: string, files: Record<string, string>): void {
	for (const [module, text] of Object.entries(files)) {
		const full = path.join(root, module);
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, text);
	}
}

export function workspaceFixture(name: string): (files: Record<string, string>) => string {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	return (files) => {
		const root = mkdtempSync(path.join(tmpdir(), `lexicon-csharp-${name}-`));
		roots.push(root);
		writeWorkspace(root, files);
		return root;
	};
}

export function startProvider(provider: CsharpProvider, workspaceRoot = "/workspace"): CsharpHandlers {
	const handlers = handlersFor(provider, SECRET_READERS);
	handlers.initialize({ workspaceRoot, protocolVersion: PROTOCOL_VERSION, policy: secretWire() });
	handlers.discoverProject({ workspaceRoot });
	sessions.set(provider, handlers);
	return handlers;
}

export function handlersOf(provider: CsharpProvider): CsharpHandlers {
	return sessions.get(provider) ?? startProvider(provider);
}

export function parseThroughKit(
	provider: CsharpProvider,
	params: { module: string; contentHash: string; text: string; depth?: "full" | "outline" },
) {
	return handlersOf(provider).parseFile(params);
}
