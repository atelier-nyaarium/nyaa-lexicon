import { handlersFor, PROTOCOL_VERSION } from "@nyaa-lexicon/protocol";
import { KotlinProvider } from "../main.js";

export function started(root: string) {
	const handlers = handlersFor(new KotlinProvider());
	handlers.initialize({ workspaceRoot: root, protocolVersion: PROTOCOL_VERSION });
	handlers.discoverProject({ workspaceRoot: root });
	return handlers;
}
