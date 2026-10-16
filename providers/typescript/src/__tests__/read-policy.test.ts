import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SECRET_READERS } from "@nyaa-lexicon/formats/secret";
import { readPolicy } from "@nyaa-lexicon/protocol";
import { secretWire } from "../../../../protocol/src/__tests__/secretWire.js";
import { readableSystem } from "../project.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("hides guarded JSON and YAML from the compiler host", () => {
	const root = mkdtempSync(path.join(tmpdir(), "lexicon-read-policy-"));
	roots.push(root);
	const files = {
		"secret.json": '{"kind":"Secret","data":{"token":"JSON_VALUE"}}',
		"secret.yaml": "kind: Secret\ndata:\n  token: YAML_VALUE\n",
		"package.json": '{"name":"plain-package","version":"1.0.0"}',
		"tsconfig.json": '{"compilerOptions":{"strict":true},"files":[]}',
		"compile_commands.json": '[{"directory":".","command":"cc","file":"src/main.c"}]',
	};
	for (const [module, text] of Object.entries(files)) writeFileSync(path.join(root, module), text);
	const system = readableSystem(readPolicy(root, secretWire(), SECRET_READERS));

	expect({
		jsonExists: system.fileExists(path.join(root, "secret.json")),
		jsonText: system.readFile(path.join(root, "secret.json")),
		yamlExists: system.fileExists(path.join(root, "secret.yaml")),
		yamlText: system.readFile(path.join(root, "secret.yaml")),
		package: system.readFile(path.join(root, "package.json")),
		config: system.readFile(path.join(root, "tsconfig.json")),
		commands: system.readFile(path.join(root, "compile_commands.json")),
	}).toEqual({
		jsonExists: false,
		jsonText: undefined,
		yamlExists: false,
		yamlText: undefined,
		package: files["package.json"],
		config: files["tsconfig.json"],
		commands: files["compile_commands.json"],
	});
});
