// The daemon-client wire: one JSON object per line, both directions, over a local socket.
//
// A closed frame vocabulary rather than bare request-response, because the connection itself now
// carries meaning: being connected IS being present, which is what the daemon's lifetime counts.
// The schemas and the wire's numbers live here so both ends read one truth; the socket code that
// speaks them lives in the client and the daemon and knows nothing about what the frames mean.

import { z } from "zod";

////////////////////////////////
//  Schemas

/** First frame a client sends. Anything else as an opener is rejected and the socket closed. */
export const HelloFrameSchema = z
	.object({
		kind: z.literal("hello"),
		/** From the lock file. Presenting it is what makes binding a TCP port safe on a shared box. */
		token: z.string().min(32),
	})
	.meta({ id: "HelloFrame" });

/** The server's yes: the token held, requests may flow. */
export const WelcomeFrameSchema = z
	.object({ kind: z.literal("welcome"), protocolVersion: z.string().min(1) })
	.meta({ id: "WelcomeFrame" });

/** The server's no, stated before the close so a bad token is distinguishable from a crash. */
export const RejectFrameSchema = z
	.object({ kind: z.literal("reject"), reason: z.string().min(1) })
	.meta({ id: "RejectFrame" });

export const RequestFrameSchema = z
	.object({
		kind: z.literal("request"),
		/** Client-chosen, echoed on the response, so slow answers never block the connection. */
		id: z.number().int().nonnegative(),
		method: z.string().min(1),
		params: z.unknown().optional(),
	})
	.meta({ id: "RequestFrame" });

export const ResponseFrameSchema = z
	.discriminatedUnion("ok", [
		z.object({
			kind: z.literal("response"),
			id: z.number().int().nonnegative(),
			ok: z.literal(true),
			result: z.unknown(),
		}),
		z.object({
			kind: z.literal("response"),
			id: z.number().int().nonnegative(),
			ok: z.literal(false),
			error: z.string(),
			/** True while the daemon has claimed its lock but cannot yet answer. Retryable. */
			starting: z.boolean().optional(),
			/** How much longer the DAEMON expects to need. The client waits on this rather than a
			 * budget of its own, since two independently chosen numbers cannot stay in agreement. */
			retryInMs: z.number().int().nonnegative().optional(),
			/** What it waits for, so a stall names itself instead of needing a bug report. */
			waitingFor: z.string().optional(),
		}),
	])
	.meta({ id: "ResponseFrame" });

/** Server-to-client liveness probe. A client answers with the same `n`; any frame counts too. */
export const PingFrameSchema = z
	.object({ kind: z.literal("ping"), n: z.number().int().nonnegative() })
	.meta({ id: "PingFrame" });
export const PongFrameSchema = z
	.object({ kind: z.literal("pong"), n: z.number().int().nonnegative() })
	.meta({ id: "PongFrame" });

/** Everything a client may say. */
export const ClientFrameSchema = z.discriminatedUnion("kind", [HelloFrameSchema, RequestFrameSchema, PongFrameSchema]);

/** Everything a server may say. */
export const ServerFrameSchema = z.union([WelcomeFrameSchema, RejectFrameSchema, ResponseFrameSchema, PingFrameSchema]);

////////////////////////////////
//  Interfaces & Types

export type HelloFrame = z.infer<typeof HelloFrameSchema>;
export type WelcomeFrame = z.infer<typeof WelcomeFrameSchema>;
export type RejectFrame = z.infer<typeof RejectFrameSchema>;
export type RequestFrame = z.infer<typeof RequestFrameSchema>;
export type ResponseFrame = z.infer<typeof ResponseFrameSchema>;
export type PingFrame = z.infer<typeof PingFrameSchema>;
export type PongFrame = z.infer<typeof PongFrameSchema>;
export type ClientFrame = z.infer<typeof ClientFrameSchema>;
export type ServerFrame = z.infer<typeof ServerFrameSchema>;

////////////////////////////////
//  Constants

/** Server-to-client ping interval; any frame from the client resets the silence count. */
export const HEARTBEAT_MS = 30_000;
/** Quiet heartbeat ticks before the server drops the socket: gone on the second, not the third. */
export const HEARTBEAT_MISSED_LIMIT = 2;
/** An unauthenticated socket may not linger; a real client hellos immediately. */
export const HELLO_DEADLINE_MS = 10_000;
/** How long a client waits for the welcome before the handshake counts as failed. */
export const CONNECT_TIMEOUT_MS = 5_000;
/** Requests are small (prose caps at 4KB); a line beyond this is a flood, not a query. */
export const SERVER_LINE_CAP = 8 * 1024 * 1024;
/** Responses carry real result sets, so the client's cap is generous rather than symmetric. */
export const CLIENT_LINE_CAP = 512 * 1024 * 1024;
