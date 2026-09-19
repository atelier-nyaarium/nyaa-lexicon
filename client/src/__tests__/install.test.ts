import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PROTOCOL_VERSION } from "@nyaa-lexicon/protocol";
import {
	bundlesSettled,
	INSTALL_SETTLE_MS,
	installRecordFile,
	newestInstallBeside,
	readInstallRecord,
	readInstallVersion,
	writeInstallRecord,
} from "../install";
import { canonicalRoot, type PlatformEnv } from "../paths";

////////////////////////////////
//  Helpers

const made: string[] = [];

function scratch(prefix: string): string {
	const dir = mkdtempSync(path.join(tmpdir(), prefix));
	made.push(dir);
	return dir;
}

function hostAt(state: string): PlatformEnv {
	return { platform: "linux", env: { XDG_STATE_HOME: state }, home: state };
}

afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

////////////////////////////////
//  Tests

describe("the install record", () => {
	it("reads back what was written, the root made canonical, under the host's state root", () => {
		const state = scratch("lexicon-install-");
		const root = scratch("lexicon-root-");
		const host = hostAt(state);

		writeInstallRecord(path.join(root, "dist", ".."), host);

		expect(installRecordFile(host)).toBe(path.join(state, "nyaa-lexicon", "install.json"));
		expect(readInstallRecord(host)).toEqual({ root: canonicalRoot(root), when: expect.any(Number) });
	});

	it("leaves nothing but the record behind, so a rewrite is one file replacing one file", () => {
		const state = scratch("lexicon-install-");
		const host = hostAt(state);

		writeInstallRecord("/first", host);
		writeInstallRecord("/second", host);

		expect(readdirSync(path.dirname(installRecordFile(host)))).toEqual(["install.json"]);
		expect(readInstallRecord(host)?.root).toBe("/second");
	});

	it("knows nothing from no record, and nothing from a malformed one", () => {
		const state = scratch("lexicon-install-");
		const host = hostAt(state);
		expect(readInstallRecord(host)).toBeNull();

		mkdirSync(path.dirname(installRecordFile(host)), { recursive: true });
		writeFileSync(installRecordFile(host), "{ not json");
		expect(readInstallRecord(host)).toBeNull();

		writeFileSync(installRecordFile(host), JSON.stringify({ root: "" }));
		expect(readInstallRecord(host)).toBeNull();
	});
});

describe("the install's version file", () => {
	it("reads what the build writes beside the bundles", () => {
		const root = scratch("lexicon-root-");
		mkdirSync(path.join(root, "dist"));
		writeFileSync(
			path.join(root, "dist", "version.json"),
			JSON.stringify({ buildVersion: "2.2.0", protocolVersion: PROTOCOL_VERSION }),
		);

		expect(readInstallVersion(root)).toEqual({ buildVersion: "2.2.0", protocolVersion: PROTOCOL_VERSION });
	});

	it("answers null for an unbuilt root and for versions that are not releases", () => {
		const root = scratch("lexicon-root-");
		expect(readInstallVersion(root)).toBeNull();

		mkdirSync(path.join(root, "dist"));
		writeFileSync(
			path.join(root, "dist", "version.json"),
			JSON.stringify({ buildVersion: "2.2", protocolVersion: "latest" }),
		);
		expect(readInstallVersion(root)).toBeNull();
	});
});

// A plugin cache installs each release into a directory named exactly its version, and an old
// session can record an older one, or one the cache has since removed.
describe("the newest install beside another", () => {
	/** A release directory as the build leaves it, its bundle backdated unless `fresh`. */
	function release(
		parent: string,
		version: string,
		options: { manifest?: string; versionFile?: string; bundle?: boolean; fresh?: boolean } = {},
	): string {
		const root = path.join(parent, version);
		mkdirSync(path.join(root, "dist"), { recursive: true });
		if (options.bundle !== false) {
			const bundle = path.join(root, "dist", "daemon.js");
			writeFileSync(bundle, `// ${version}\n`);
			if (options.fresh !== true) {
				const past = new Date(Date.now() - 60_000);
				utimesSync(bundle, past, past);
			}
		}
		writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: options.manifest ?? version }));
		writeFileSync(
			path.join(root, "dist", "version.json"),
			JSON.stringify({ buildVersion: options.versionFile ?? version, protocolVersion: PROTOCOL_VERSION }),
		);
		return root;
	}

	const settledBefore = () => Date.now() - INSTALL_SETTLE_MS;

	it("picks the newest release by its triple, the root itself included", () => {
		const parent = scratch("lexicon-cache-");
		const old = release(parent, "8.2.0");
		release(parent, "8.9.0");
		release(parent, "8.10.0");

		expect(newestInstallBeside(old, settledBefore())).toEqual({
			root: path.join(parent, "8.10.0"),
			version: "8.10.0",
		});
		expect(newestInstallBeside(path.join(parent, "8.10.0"), settledBefore())?.version).toBe("8.10.0");
	});

	it("answers for a recorded root that is gone, so a removed version gives way", () => {
		const parent = scratch("lexicon-cache-");
		release(parent, "8.2.1");

		expect(newestInstallBeside(path.join(parent, "8.2.0"), settledBefore())?.root).toBe(path.join(parent, "8.2.1"));
	});

	it("skips a directory whose manifest or version file disagrees with its name", () => {
		const parent = scratch("lexicon-cache-");
		const root = release(parent, "8.2.0");
		release(parent, "8.3.0", { manifest: "8.2.0" });
		release(parent, "8.4.0", { versionFile: "8.3.0" });

		expect(newestInstallBeside(root, settledBefore())?.version).toBe("8.2.0");
	});

	it("skips a bundle still being written and a directory with no daemon bundle", () => {
		const parent = scratch("lexicon-cache-");
		const root = release(parent, "8.2.0");
		release(parent, "8.3.0", { fresh: true });
		release(parent, "8.4.0", { bundle: false });

		expect(newestInstallBeside(root, settledBefore())?.version).toBe("8.2.0");
	});

	it("ignores directories not named for a release", () => {
		const parent = scratch("lexicon-cache-");
		const root = release(parent, "8.2.0");
		mkdirSync(path.join(parent, "8.9.0garbage", "dist"), { recursive: true });
		mkdirSync(path.join(parent, "latest", "dist"), { recursive: true });

		expect(newestInstallBeside(root, settledBefore())?.version).toBe("8.2.0");
	});

	// A sibling of a source checkout is some other project, never an install of this build.
	it("scans nothing when the root is not named for a release", () => {
		const parent = scratch("lexicon-cache-");
		const checkout = path.join(parent, "nyaa-lexicon");
		mkdirSync(checkout);
		release(parent, "9.9.9");

		expect(newestInstallBeside(checkout, settledBefore())).toBeNull();
	});

	it("counts a root with no bundle as unsettled", () => {
		expect(bundlesSettled(scratch("lexicon-root-"), settledBefore())).toBe(false);
	});
});
