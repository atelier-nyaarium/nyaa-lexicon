import { SECRET_READERS } from "@nyaa-lexicon/formats/secret";
import { handlersFor, PROTOCOL_VERSION } from "@nyaa-lexicon/protocol";
import { secretWire } from "../../../../protocol/src/__tests__/secretWire.js";
import { KotlinProvider } from "../main.js";

export function started(root: string) {
	const handlers = handlersFor(new KotlinProvider(), SECRET_READERS);
	handlers.initialize({ workspaceRoot: root, protocolVersion: PROTOCOL_VERSION, policy: secretWire() });
	handlers.discoverProject({ workspaceRoot: root });
	return handlers;
}
