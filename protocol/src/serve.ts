// One wiring for every provider, built from the method table rather than from string literals.
//
// PROVIDER_METHODS says a typo should be a compile error. That only holds if nobody spells a method
// name by hand, so the dispatch loop below is the single place a wire name is ever written.

import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import type { z } from "zod";
import type { METHOD_SCHEMAS, ProviderMethod } from "./methods.js";
import { PROVIDER_METHODS } from "./methods.js";
import type { MoveEditsResponse } from "./move.js";
import type { ImportResolution } from "./project.js";
import { normalizeModulePath } from "./symbolId.js";
import type { Binding, TypeInfo } from "./values.js";

////////////////////////////////
//  Interfaces & Types

type Connection = ReturnType<typeof createMessageConnection>;

/**
 * Every method, always. A capability a provider lacks answers Unknown through the value types.
 *
 * Required keys are the enforcement: a method added to PROVIDER_METHODS fails to compile in every
 * provider until it is answered, which is the guarantee the frozen list was written to give.
 */
export type ProviderHandlers = {
	[M in ProviderMethod]: (
		params: z.infer<(typeof METHOD_SCHEMAS)[M]["request"]>,
	) => z.infer<(typeof METHOD_SCHEMAS)[M]["response"]>;
};

////////////////////////////////
//  Functions & Helpers

/** Bad request, before any handler. */
function refuseUnrepresentable(params: unknown): void {
	if (typeof params !== "object" || params === null) return;
	for (const field of ["module", "fromModule", "toModule"]) {
		const value = (params as Record<string, unknown>)[field];
		if (typeof value === "string") normalizeModulePath(value);
	}
}

export function serveProvider(connection: Connection, handlers: ProviderHandlers): void {
	for (const method of PROVIDER_METHODS) {
		// The handler map is keyed per method, so the loop erases the pairing the caller already
		// satisfied. Each response is still validated against its schema by whoever reads it.
		const handler = handlers[method] as (params: unknown) => unknown;
		connection.onRequest(method, (params: unknown) => {
			refuseUnrepresentable(params);
			return handler(params);
		});
	}
}

export function runProviderOnStdio(handlers: ProviderHandlers): void {
	const connection = createMessageConnection(
		new StreamMessageReader(process.stdin),
		new StreamMessageWriter(process.stdout),
	);
	serveProvider(connection, handlers);
	exitWhenClosed(process.stdin);
	connection.listen();
}

/**
 * stdin closing means the daemon is gone, however it went. A provider holding any live handle
 * would otherwise outlive it as an orphan (issue #7).
 */
export function exitWhenClosed(stream: NodeJS.ReadableStream, exit: (code: number) => void = process.exit): void {
	let left = false;
	const leave = () => {
		if (left) return;
		left = true;
		exit(0);
	};
	stream.on("end", leave);
	stream.on("close", leave);
}

////////////////////////////////
//  Undeclared tiers

// Handed out rather than hand-written, so an undeclared tier cannot answer with a reason that does
// not match what it is, which a literal triple gets subtly wrong.

export function notImplementedBinding(detail: string): Binding {
	return { status: "unbound", reason: "NotImplemented", detail };
}

export function notImplementedType(detail: string): TypeInfo {
	return { status: "unknown", reason: "NotImplemented", detail };
}

export function notImplementedImport(detail: string): ImportResolution {
	return { status: "unresolved", reason: "NotImplemented", detail };
}

export function notImplementedMove(detail: string): MoveEditsResponse {
	return { status: "refused", reason: "NotImplemented", detail };
}
