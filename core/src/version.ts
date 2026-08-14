// What build this is, for deciding whether a daemon we found is one of ours.
//
// Distinct from the protocol version, which is about CORE speaking to PROVIDERS and is negotiated
// on a major. This one is about a client speaking to a DAEMON, where the contract is the method
// table and any release can add to it. A 1.9.0 daemon answering a 1.10.2 client cannot serve a
// method that did not exist when it started, and nothing about the provider protocol changed to
// say so, which is how a stale daemon comes to answer `unknown method` for a tool that shipped.
//
// DERIVED, never a literal. scripts/build.ts verifies this line still computes rather than states,
// because a hard-coded version reads as correct right up until the next bump ships a daemon lying
// about what it is.

import packageJson from "../../package.json";

/** This build's version, as the manifests declare it. */
export const BUILD_VERSION: string = packageJson.version;
