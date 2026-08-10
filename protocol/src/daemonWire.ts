// The daemon-client wire: one JSON object per line, both directions, over a local socket.
//
// A closed frame vocabulary rather than bare request-response, because the connection itself now
// carries meaning: being connected IS being present, which is what the daemon's lifetime counts.
// The schemas live here so the wire has one truth; the socket code that speaks them lives in one
// core module and knows nothing about what the frames mean.

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
