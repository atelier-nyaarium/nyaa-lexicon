// What a daemon writes to disk for a client to read: its lock, and where the install lives.
//
// Contracts rather than core internals, so a client built from protocol alone reads them.

import { z } from "zod";

////////////////////////////////
//  Schemas

export const DaemonLockSchema = z
	.object({
		/** Localhost port. Chosen by the OS at bind, never fixed, so two workspaces cannot collide. */
		port: z.number().int().positive(),
		/** Presented on every call. Closes the hole that binding a TCP port opens on a shared box. */
		token: z.string().min(32),
		pid: z.number().int().positive(),
		/** The pid's birth ticks where the platform offers them. A reused pid fails this, so a dead
		 * daemon can never read as live on pid alone (issue #7). */
		pidStart: z.string().min(1).optional(),
		/** Protocol version the daemon speaks, so a client on a different major replaces it. */
		protocolVersion: z.string().min(1),
		/** The BUILD the daemon runs, which decides its method table. Absent reads as a mismatch. */
		buildVersion: z.string().min(1).optional(),
		/** Which BUNDLE, so a rebuild inside one version is noticed too. */
		bundleStamp: z.string().min(1).optional(),
		workspaceRoot: z.string().min(1),
		startedAt: z.number().int().nonnegative(),
	})
	.meta({ id: "DaemonLock" });

/** Where lexicon was last seen: the checkout a client spawns a daemon from. */
export const InstallRecordSchema = z
	.object({
		root: z.string().min(1),
		/** Epoch millis of the write, so a stale record can say how stale. */
		when: z.number(),
	})
	.meta({ id: "InstallRecord" });

/** Whole semver only, as the build writes it; a client compares majors from it. */
const RELEASE_RE = /^\d+\.\d+\.\d+$/;

/** What an install says about itself in `dist/version.json`, so a client learns it without running it. */
export const InstallVersionSchema = z
	.object({
		buildVersion: z.string().regex(RELEASE_RE),
		protocolVersion: z.string().regex(RELEASE_RE),
	})
	.meta({ id: "InstallVersion" });

////////////////////////////////
//  Interfaces & Types

export type DaemonLock = z.infer<typeof DaemonLockSchema>;
export type InstallRecord = z.infer<typeof InstallRecordSchema>;
export type InstallVersion = z.infer<typeof InstallVersionSchema>;
