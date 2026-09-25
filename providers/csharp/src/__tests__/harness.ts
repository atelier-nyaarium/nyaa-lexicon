import { handlersFor, PROTOCOL_VERSION } from "@nyaa-lexicon/protocol";
import type { CsharpProvider } from "../main.js";

type CsharpHandlers = ReturnType<typeof handlersFor>;

const sessions = new WeakMap<CsharpProvider, CsharpHandlers>();

export function startProvider(provider: CsharpProvider, workspaceRoot = "/workspace"): CsharpHandlers {
	const handlers = handlersFor(provider);
	handlers.initialize({ workspaceRoot, protocolVersion: PROTOCOL_VERSION });
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
