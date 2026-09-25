import { expect, it } from "bun:test";
import { FileFactsSchema, PROTOCOL_VERSION } from "@nyaa-lexicon/protocol";
import { CsharpProvider } from "../main.js";
import { handlersOf, parseThroughKit } from "./harness.js";

it("names a static Main declaration as the entry point in parses and probes", () => {
	const provider = new CsharpProvider();
	const params = {
		module: "src/Program.cs",
		contentHash: "role",
		text: "namespace Demo { public static class Program { public static void Main(string[] args) {} } }\n",
	};
	const parsed = parseThroughKit(provider, params);
	const main = parsed.declarations.find((declaration) => declaration.name === "Main");
	if (main === undefined) throw new Error("Main declaration missing");

	expect(
		handlersOf(provider).initialize({ workspaceRoot: "/workspace", protocolVersion: PROTOCOL_VERSION }).tiers
			.fileRoles,
	).toBe(true);
	expect(parsed.role).toEqual({ kind: "entry", how: "main", symbolId: main.symbolId });
	expect(
		handlersOf(provider).probeFile({
			module: params.module,
			contentHash: "probe",
			text: params.text,
		}).role,
	).toEqual(parsed.role);
	FileFactsSchema.parse(parsed);
});

it("treats a file without a static Main declaration as a library", () => {
	const facts = parseThroughKit(new CsharpProvider(), {
		module: "src/Cart.cs",
		contentHash: "role",
		text: "namespace Demo { public class Cart { public void Main() {} public static void Start() {} } }\n",
	});

	expect(facts.role).toEqual({ kind: "library" });
	FileFactsSchema.parse(facts);
});

it("marks skipped file-scope statements unknown", () => {
	const facts = parseThroughKit(new CsharpProvider(), {
		module: "src/Program.cs",
		contentHash: "role",
		text: 'System.Console.WriteLine("hello");\n',
	});

	expect(facts.role).toEqual({ kind: "unknown", reason: "NotImplemented" });
	FileFactsSchema.parse(facts);
});
