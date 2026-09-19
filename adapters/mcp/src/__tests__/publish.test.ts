import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { lexiconRoot } from "@nyaa-lexicon/core";
import { main, PUBLISH_INSTALL_FLAG, publishInstallIfAsked } from "../serve";

const ROOT = path.join(import.meta.dirname, "..", "..", "..", "..");

////////////////////////////////
//  Tests

describe("publishing the install record", () => {
	it("records this checkout only when the launch passes the flag", () => {
		const published: string[] = [];
		const publish = (root: string) => {
			published.push(root);
		};

		expect(publishInstallIfAsked([], publish)).toBe(false);
		expect(publishInstallIfAsked(["--version"], publish)).toBe(false);
		expect(published).toEqual([]);

		expect(publishInstallIfAsked([PUBLISH_INSTALL_FLAG], publish)).toBe(true);
		expect(published).toEqual([lexiconRoot()]);
	});

	it("keeps the server starting when the write fails, since it does not need the record", () => {
		const failing = () => {
			throw new Error("read-only state root");
		};

		expect(publishInstallIfAsked([PUBLISH_INSTALL_FLAG], failing)).toBe(false);
	});

	// The version answer runs before anything is recorded, so asking what this is never writes.
	it("records nothing when the launch only asks for the version", async () => {
		const state = mkdtempSync(path.join(tmpdir(), "lexicon-publish-state-"));
		const previous = process.env["XDG_STATE_HOME"];
		process.env["XDG_STATE_HOME"] = state;
		try {
			await main(["--version", PUBLISH_INSTALL_FLAG]);

			expect(existsSync(path.join(state, "nyaa-lexicon", "install.json"))).toBe(false);
		} finally {
			if (previous === undefined) delete process.env["XDG_STATE_HOME"];
			else process.env["XDG_STATE_HOME"] = previous;
			rmSync(state, { recursive: true, force: true });
		}
	});

	it("is asked for by the plugin's own launch", () => {
		const config = JSON.parse(readFileSync(path.join(ROOT, ".mcp.json"), "utf8"));

		expect(config.mcpServers.lexicon.args).toContain(PUBLISH_INSTALL_FLAG);
	});
});
