import { describe, expect, it } from "bun:test";
import { createReader, encode, type Message } from "../transport";

////////////////////////////////
//  Helpers

function collect() {
	const seen: Message[] = [];
	const problems: string[] = [];
	return {
		seen,
		problems,
		read: createReader(
			(m) => seen.push(m),
			(p) => problems.push(p),
		),
	};
}

const HELLO: Message = { jsonrpc: "2.0", id: 1, method: "initialize" };

////////////////////////////////
//  Tests

describe("framing", () => {
	it("round trips a message", () => {
		const { seen, read } = collect();
		read(encode(HELLO));
		expect(seen).toEqual([HELLO]);
	});

	it("counts BYTES rather than characters, so one emoji does not desynchronise the stream", () => {
		const withEmoji: Message = { jsonrpc: "2.0", id: 2, method: "x", params: { text: "e" } };
		const framed = encode(withEmoji);
		const declared = Number(/Content-Length: (\d+)/.exec(framed.toString("ascii"))?.[1]);

		expect(declared).toBe(Buffer.from(JSON.stringify(withEmoji), "utf8").length);

		const { seen, read } = collect();
		read(framed);
		expect(seen).toEqual([withEmoji]);
	});
});

describe("reading a stream", () => {
	// A chunk boundary falls wherever the OS put it. All three of these are ordinary rather than
	// exotic, and a parser that only handles whole messages breaks on the first busy moment.
	it("survives a message split across chunks, one byte at a time", () => {
		const { seen, read } = collect();
		const framed = encode(HELLO);
		for (const byte of framed) read(Buffer.from([byte]));

		expect(seen).toEqual([HELLO]);
	});

	it("reads several messages arriving in one chunk", () => {
		const second: Message = { jsonrpc: "2.0", id: 2, method: "shutdown" };
		const { seen, read } = collect();
		read(Buffer.concat([encode(HELLO), encode(second)]));

		expect(seen).toEqual([HELLO, second]);
	});

	it("waits rather than guessing when only half a header has arrived", () => {
		const { seen, read } = collect();
		read(Buffer.from("Content-Len", "ascii"));
		expect(seen).toEqual([]);
	});

	// One bad frame must not take the connection down: an editor that loses the stream shows a
	// protocol error rather than a missing answer.
	it("reports a malformed body and keeps reading", () => {
		const { seen, problems, read } = collect();
		const broken = Buffer.from("Content-Length: 3\r\n\r\n{{{", "utf8");
		read(Buffer.concat([broken, encode(HELLO)]));

		expect(problems).toHaveLength(1);
		expect(seen).toEqual([HELLO]);
	});

	it("resynchronises after a header with no length", () => {
		const { seen, problems, read } = collect();
		read(Buffer.concat([Buffer.from("Nonsense: 1\r\n\r\n", "ascii"), encode(HELLO)]));

		expect(problems).toHaveLength(1);
		expect(seen).toEqual([HELLO]);
	});
});
