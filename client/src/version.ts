// Which build this client is, standing in for the install's when none is known.
//
// Not the protocol version: a patch can add a method without moving it.

import packageJson from "../../package.json";

/** Derived, never a literal. scripts/build.ts checks. */
export const CLIENT_BUILD_VERSION: string = packageJson.version;
