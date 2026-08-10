////////////////////////////////
//  Interfaces & Types
import { PROTOCOL_VERSION } from "@nyaa-lexicon/protocol";
////////////////////////////////
//  Functions & Helpers
/**
 * The daemon's own identity.
 *
 * Phase 4 lands the daemon itself; this exists so the package boundary and the
 * dependency direction (core -> protocol, never the reverse) are real from day one.
 */
export function daemonIdentity(workspaceRoot) {
    return { workspaceRoot, protocolVersion: PROTOCOL_VERSION };
}
//# sourceMappingURL=index.js.map