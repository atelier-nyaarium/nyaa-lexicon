import { describe, expect, test } from "bun:test";
import { firstLineOf, shebangInterpreter } from "../shebang.js";

describe("the interpreter a shebang names", () => {
	test("a path, env, and env with options or assignments all name the program", () => {
		const spellings: Record<string, string | undefined> = {
			"#!/bin/bash": "bash",
			"#! /bin/bash": "bash",
			"#!\t/usr/local/bin/bash -e": "bash",
			"#!/nix/store/abc-bash-5.2/bin/bash": "bash",
			"#!/usr/bin/env bash": "bash",
			"#!/usr/bin/env -S bash -e": "bash",
			"#!/usr/bin/env -iS bash": "bash",
			"#!/usr/bin/env -u NAME bash": "bash",
			"#!/usr/bin/env FOO=1 bash": "bash",
			"#!/usr/bin/env -S /bin/sh": "sh",
			"#!/usr/bin/env -- -u": "-u",
			"#!/usr/bin/env --": undefined,
			"#!\0bash": undefined,
			"#!/bin/": undefined,
			"#!/usr/bin/env bash/": undefined,
			"#!/usr/bin/env python3": "python3",
			"#!/bin/bash5": "bash5",
			"#!/usr/bin/env": undefined,
			"#!/usr/bin/env -S": undefined,
			"#!": undefined,
			"#!bash": "bash",
			"echo no shebang": undefined,
			"": undefined,
		};
		for (const [line, interpreter] of Object.entries(spellings)) {
			expect([line, shebangInterpreter(line)]).toEqual([line, interpreter]);
		}
	});

	test("the first line stops at the newline and drops a carriage return", () => {
		expect(firstLineOf("#!/bin/bash\r\necho\r\n")).toBe("#!/bin/bash");
		expect(firstLineOf("#!/bin/sh")).toBe("#!/bin/sh");
		expect(shebangInterpreter(firstLineOf("#!/usr/bin/env bash\r\n"))).toBe("bash");
	});
});
