import { describe, expect, it } from "bun:test";
import { DaemonLockSchema, parseDaemonLock } from "../daemonRecords.js";

////////////////////////////////
//  Helpers

const RAW = {
	port: 41234,
	token: "t".repeat(32),
	pid: 4242,
	protocolVersion: "3.4.0",
	workspaceRoot: "/home/me/proj",
	startedAt: 1,
};

////////////////////////////////
//  Tests

describe("parsing a lock's raw text", () => {
	it("parses a valid lock", () => {
		expect(parseDaemonLock(JSON.stringify(RAW))).toEqual(RAW);
	});

	it("answers null on unreadable JSON", () => {
		expect(parseDaemonLock("{ not json")).toBeNull();
	});

	it("answers null on a shape that does not validate", () => {
		expect(parseDaemonLock(JSON.stringify({ ...RAW, port: -1 }))).toBeNull();
	});

	it("carries a role through when the lock names one", () => {
		expect(parseDaemonLock(JSON.stringify({ ...RAW, role: "delete" }))?.role).toBe("delete");
	});
});

// Absent must keep meaning "daemon": a lock minted before this field existed still reads the way
// it always has, and DaemonLockSchema is what every reader of a lock trusts for that.
describe("a lock's role", () => {
	it("is optional, so an older lock with none still validates", () => {
		expect(DaemonLockSchema.safeParse(RAW).success).toBe(true);
	});

	it("refuses a role outside the closed set", () => {
		expect(DaemonLockSchema.safeParse({ ...RAW, role: "provider" }).success).toBe(false);
	});
});
