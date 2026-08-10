// LSP's base protocol framing, which is not JSON-RPC's and not newline-delimited.
//
// A message is `Content-Length: N\r\n\r\n` followed by exactly N BYTES of UTF-8. Bytes, not
// characters: a header saying 12 for a body containing one emoji means 12 bytes, and counting
// characters instead silently desynchronises the stream from the first non-ASCII message onward.
// That is why this buffers Buffers rather than strings.

////////////////////////////////
//  Interfaces & Types

export interface Message {
	jsonrpc: "2.0";
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string };
}

////////////////////////////////
//  Constants

const SEPARATOR = "\r\n\r\n";

////////////////////////////////
//  Functions & Helpers

/** Frame one message for the wire. */
export function encode(message: Message): Buffer {
	const body = Buffer.from(JSON.stringify(message), "utf8");
	return Buffer.concat([Buffer.from(`Content-Length: ${body.length}${SEPARATOR}`, "ascii"), body]);
}

/**
 * Accumulates bytes and yields whole messages.
 *
 * A stateful reader rather than a parse function, because a chunk boundary falls wherever the OS
 * put it: half a header, several messages at once, or a body split down the middle are all
 * ordinary, and only something holding the leftovers can survive them.
 */
export function createReader(onMessage: (message: Message) => void, onError?: (problem: string) => void) {
	let buffer = Buffer.alloc(0);

	return (chunk: Buffer): void => {
		buffer = Buffer.concat([buffer, chunk]);

		for (;;) {
			const headerEnd = buffer.indexOf(SEPARATOR);
			if (headerEnd < 0) return;

			const headers = buffer.subarray(0, headerEnd).toString("ascii");
			const match = /content-length:\s*(\d+)/i.exec(headers);
			if (match === null) {
				// Unrecoverable: without a length there is no way to know where this message ends, so
				// the only safe move is to drop the header and resynchronise rather than guess.
				onError?.("a message arrived with no Content-Length");
				buffer = buffer.subarray(headerEnd + SEPARATOR.length);
				continue;
			}

			const length = Number(match[1]);
			const start = headerEnd + SEPARATOR.length;
			if (buffer.length < start + length) return;

			const body = buffer.subarray(start, start + length).toString("utf8");
			buffer = buffer.subarray(start + length);
			try {
				onMessage(JSON.parse(body) as Message);
			} catch {
				// One malformed body is that message's problem. Throwing here would take down the
				// connection over a single bad frame.
				onError?.("a message body was not valid JSON");
			}
		}
	};
}
