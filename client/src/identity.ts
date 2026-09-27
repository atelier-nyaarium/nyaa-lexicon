// The SOLE owner of process identity marks: whether a pid is still the process that wrote a lock.
// Linux marks by birth ticks. Windows marks by a held named pipe carrying the pid, gone with the process.

import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { createServer } from "node:net";
import { processIdentity } from "./procfs.js";

////////////////////////////////
//  Constants

const PIPES = "\\\\.\\pipe\\";
const PIPE_MARK = "pipe:";
const PIPE_PREFIX = "nyaa-lexicon-";

////////////////////////////////
//  Functions & Helpers

let heldPipe: string | null | undefined;

/** Listed once `listen` returns, in node and bun alike. */
function pipeListed(name: string): boolean | null {
	try {
		return readdirSync(PIPES).includes(name);
	} catch {
		return null;
	}
}

/** Relistens when closed, so a live holder never reads dead. */
function listen(name: string): void {
	const server = createServer((socket) => socket.destroy());
	let listening = false;
	server.on("error", () => {});
	server.once("listening", () => {
		listening = true;
	});
	server.once("close", () => {
		if (listening) listen(name);
	});
	server.listen(`${PIPES}${name}`);
	server.unref();
}

/** One per process, never keeping it alive. */
function holdPipe(): string | null {
	if (heldPipe !== undefined) return heldPipe;
	const name = `${PIPE_PREFIX}${process.pid}-${randomBytes(8).toString("hex")}`;
	listen(name);
	heldPipe = pipeListed(name) === true ? name : null;
	return heldPipe;
}

////////////////////////////////
//  Functions

/** This process's mark; undefined where the platform has none. */
export function ownMark(): string | undefined {
	if (process.platform === "win32") {
		const pipe = holdPipe();
		return pipe === null ? undefined : `${PIPE_MARK}${pipe}`;
	}
	return processIdentity(process.pid)?.startTicks;
}

/** False for a zombie or a stranger on a reused pid; null where the platform cannot say. */
export function markVerdict(pid: number, mark: string | undefined): boolean | null {
	if (process.platform === "win32") {
		if (mark === undefined || !mark.startsWith(PIPE_MARK)) return null;
		const pipe = mark.slice(PIPE_MARK.length);
		if (!pipe.startsWith(`${PIPE_PREFIX}${pid}-`)) return false;
		return pipeListed(pipe);
	}
	const identity = processIdentity(pid);
	if (identity === null) return null;
	if (identity.zombie) return false;
	return mark === undefined ? null : identity.startTicks === mark;
}
