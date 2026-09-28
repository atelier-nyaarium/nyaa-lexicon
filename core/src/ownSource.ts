// This checkout as the place a daemon comes from.
//
// The client takes every root as an argument; core is the one side that knows its own.

import { bundleStamp, bundleWrittenAt, type DaemonSource } from "@nyaa-lexicon/client";
import { lexiconRoot } from "./providers.js";
import { BUILD_VERSION } from "./version.js";

////////////////////////////////
//  Functions & Helpers

/** The build running this code: its root, its version, and its bundle's stamp and write time. */
export function ownSource(): DaemonSource {
	const root = lexiconRoot();
	return {
		root,
		buildVersion: BUILD_VERSION,
		bundleStamp: bundleStamp(root),
		bundleWrittenAt: bundleWrittenAt(root),
	};
}
