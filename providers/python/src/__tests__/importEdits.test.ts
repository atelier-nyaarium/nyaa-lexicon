import { expect, it } from "bun:test";
import { applyEdits, type ImportEditsResponse } from "@nyaa-lexicon/protocol";
import { PythonProvider } from "../main";

/** The text with the planned import of `Host` from app/hosts.py, else the answer. */
function imported(text: string, module = "app/use.py"): string | ImportEditsResponse {
	const answer = new PythonProvider().importEdits({ module, text, name: "Host", fromModule: "app/hosts.py" });
	if (answer.status !== "planned") return answer;
	const result = applyEdits(text, answer.edits);
	return "problem" in result ? result.problem : result.text;
}

it("writes the import after the shebang, encoding line, docstring and future imports, nothing above them", () => {
	expect([
		imported("#!/usr/bin/env python\n# -*- coding: utf-8 -*-\nHost()\n"),
		imported('"""Doc."""\nfrom __future__ import annotations\n\nHost()\n'),
		imported("Host()\n", "app/sub/use.py"),
	]).toEqual([
		"#!/usr/bin/env python\n# -*- coding: utf-8 -*-\nfrom .hosts import Host\nHost()\n",
		'"""Doc."""\nfrom __future__ import annotations\nfrom .hosts import Host\n\nHost()\n',
		"from ..hosts import Host\nHost()\n",
	]);
});

it("writes an absolute import from outside the target's top-level package", () => {
	expect([imported("Host()\n", "main.py"), imported("Host()\n", "tests/test_hosts.py")]).toEqual([
		"from app.hosts import Host\nHost()\n",
		"from app.hosts import Host\nHost()\n",
	]);
});

it("answers present for the same binding and refuses another binding or text that does not parse", () => {
	expect([
		imported("from .hosts import Host\nHost()\n"),
		// The same module, spelled absolute.
		imported("from app.hosts import Host\nHost()\n"),
		imported("from app.other import Host\nHost()\n"),
		imported("Host = 1\nHost()\n"),
		imported("def broken(:\n"),
	]).toMatchObject([
		{ status: "present" },
		{ status: "present" },
		{ status: "refused", reason: "TargetCollision" },
		{ status: "refused", reason: "TargetCollision" },
		{ status: "refused", reason: "ParseError" },
	]);
});
