////////////////////////////////
//  Interfaces & Types
/**
 * The provider protocol version this build speaks.
 *
 * Negotiated at initialize. Additive-only within a major, so an older provider
 * keeps working against a newer core. See docs/provider-protocol.md.
 */
export const PROTOCOL_VERSION = "0.1.0";
////////////////////////////////
//  Functions & Helpers
/**
 * Whether this core can speak to a provider announcing `theirs`.
 *
 * Phase 1 is an exact-major check only; Phase 2 lands the real negotiation
 * alongside the schemas it has to guard.
 */
export function isCompatibleProtocol(theirs) {
    const ourMajor = PROTOCOL_VERSION.split(".")[0];
    const theirMajor = theirs.split(".")[0];
    return ourMajor !== undefined && ourMajor === theirMajor;
}
//# sourceMappingURL=index.js.map