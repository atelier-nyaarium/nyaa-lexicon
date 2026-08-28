import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PROTOCOL_VERSION } from "@nyaa-lexicon/protocol";
import { installRecordFile, readInstallRecord, readInstallVersion, writeInstallRecord } from "../install";
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
