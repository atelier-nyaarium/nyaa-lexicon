/**
 * The provider protocol version this build speaks.
 *
 * Negotiated at initialize. Additive-only within a major, so an older provider
 * keeps working against a newer core. See docs/provider-protocol.md.
 */
export declare const PROTOCOL_VERSION: "0.1.0";
/**
 * Whether this core can speak to a provider announcing `theirs`.
 *
 * Phase 1 is an exact-major check only; Phase 2 lands the real negotiation
 * alongside the schemas it has to guard.
 */
export declare function isCompatibleProtocol(theirs: string): boolean;
//# sourceMappingURL=index.d.ts.map