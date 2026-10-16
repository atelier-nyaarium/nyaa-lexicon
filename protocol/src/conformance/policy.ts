import { hashContent } from "../hash.js";

const fields = {
	builtIns: "7de8efcd2b83892d51e3afd575209817",
	secrets: {},
	deny: ["**/.git/**"],
	syntax: 1,
	trackingKind: "untracked" as const,
	tracked: [] as string[],
	aliases: [] as Array<[string, string[]]>,
	targets: [] as Array<[string, string]>,
};

export const CONFORMANCE_POLICY = {
	revision: hashContent(JSON.stringify({ ...fields, directoryLinks: [] })),
	...fields,
};
