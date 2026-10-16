// Which build this is, for deciding whether a daemon is one of ours.
//
// Not the protocol version: that negotiates on a major, this compares exactly.

import packageJson from "../../package.json";

/** Derived, never a literal. scripts/build.ts checks. */
export const BUILD_VERSION: string = packageJson.version;

const major = /^(\d+)\./.exec(BUILD_VERSION)?.[1];
if (major === undefined) throw new Error(`the build version ${BUILD_VERSION} has no major`);

/** Major written to the store, for scrub ordering. */
export const BUILD_MAJOR: number = Number(major);
