// One wiring for every provider, built from the method table rather than from string literals.
//
// PROVIDER_METHODS says a typo should be a compile error. That only holds if nobody spells a method
// name by hand, so the dispatch loop below is the single place a wire name is ever written.

import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import type { z } from "zod";
import type { METHOD_SCHEMAS, ProviderMethod, ProviderNotification } from "./methods.js";
import { NOTIFICATION_SCHEMAS, PROVIDER_METHODS, PROVIDER_NOTIFICATIONS } from "./methods.js";
import type { MoveEditsResponse } from "./move.js";
import { withOccurrences } from "./occurrences.js";
import type { FileFacts, ImportResolution } from "./project.js";
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

/** Optional, unlike methods: a notification a provider does not handle is ignored. */
export type ProviderNotificationHandlers = {
	[N in ProviderNotification]?: (params: z.infer<(typeof NOTIFICATION_SCHEMAS)[N]>) => void;
};

////////////////////////////////
//  Functions & Helpers

/** A parse answer shaped enough to settle; anything else is left for the schema to refuse. */
function hasDeclarations(answer: unknown): answer is FileFacts {
	return typeof answer === "object" && answer !== null && Array.isArray((answer as FileFacts).declarations);
}

/** Bad request, before any handler. */
function refuseUnrepresentable(params: unknown): void {
	if (typeof params !== "object" || params === null) return;
	for (const field of ["module", "fromModule", "toModule"]) {
		const value = (params as Record<string, unknown>)[field];
		if (typeof value === "string") normalizeModulePath(value);
	}
}

/**
 * Handlers run one at a time, in arrival order, async ones included. A probe's restore therefore
 * lands before anything sent after it, even a request the daemon sent once the probe timed out.
 */
export function serveProvider(connection: Connection, handlers: ProviderHandlers & ProviderNotificationHandlers): void {
	let tail: Promise<unknown> = Promise.resolve();
	const inTurn = <T>(work: () => T | Promise<T>): Promise<T> => {
		const turn = tail.then(work);
		tail = turn.catch(() => {});
		return turn;
	};
	for (const notification of PROVIDER_NOTIFICATIONS) {
		// The loop erases the pairing the caller's own type satisfied; the schema below restores it.
		// An async handler still answers a promise, awaited in turn.
		const handler = handlers[notification] as ((params: unknown) => unknown) | undefined;
		// Registered either way, so an unhandled one is a decision rather than a library log line.
		connection.onNotification(notification, (params: unknown) => {
			if (handler === undefined) return;
			void inTurn(async () => {
				try {
					refuseUnrepresentable(params);
					await handler(NOTIFICATION_SCHEMAS[notification].parse(params));
				} catch (error) {
					// No reply carries a refusal.
					console.error(`${notification} refused: ${error instanceof Error ? error.message : String(error)}`);
				}
			});
		});
	}
	for (const method of PROVIDER_METHODS) {
		// The handler map is keyed per method, so the loop erases the pairing the caller already
		// satisfied. Each response is still validated against its schema by whoever reads it.
		const handler = handlers[method] as (params: unknown) => unknown;
		connection.onRequest(method, (params: unknown) =>
			inTurn(async () => {
				refuseUnrepresentable(params);
				const answer = await handler(params);
				// One id per declaration, settled at the wire for every provider.
				const parsed = method === "parseFile" || method === "probeFile";
				return parsed && hasDeclarations(answer) ? withOccurrences(answer) : answer;
			}),
		);
	}
}

export function runProviderOnStdio(handlers: ProviderHandlers & ProviderNotificationHandlers): void {
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
