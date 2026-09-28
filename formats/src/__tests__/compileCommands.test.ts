import { describe, expect, it } from "bun:test";
import path from "node:path";
import { readCompileCommands, splitCommand } from "../compileCommands";

const read = (entries: unknown[]) =>
	readCompileCommands({
		module: "compile_commands.json",
		text: JSON.stringify(entries),
		location: path.resolve("/work"),
	});

describe("compilation database", () => {
	it("reads each option joined or apart, in order, against the entry's directory", () => {
		const database = read([
			{
				directory: "build",
				file: "../src/a.c",
				command:
					'cc -I inc -I../shared -iquote q -isystem /sys -idirafter late "-DNAME=a b" -DFLAG -UOLD -D OLD=2 -UGONE -include pre.h -include-pch skip.pch -undef -c ../src/a.c',
			},
			{ directory: ".", file: "b.c", arguments: ["cl.exe", "/Iwin", "/DWIN", "/FIforced.h", "b.c"] },
			{ file: "missing.c" },
		]);
		const build = path.resolve("/work/build");

		expect(database.commands).toEqual([
			{
				file: path.resolve("/work/src/a.c"),
				directory: build,
				includes: {
					includerDirectory: true,
					quote: [path.join(build, "q")],
					user: [path.join(build, "inc"), path.resolve("/work/shared")],
					system: [path.resolve("/sys")],
					after: [path.join(build, "late")],
				},
				forcedIncludes: ["pre.h"],
				defines: { NAME: "a b", FLAG: "1", OLD: "2" },
				undefines: ["GONE"],
			},
			{
				file: path.resolve("/work/b.c"),
				directory: path.resolve("/work"),
				includes: {
					includerDirectory: true,
					quote: [],
					user: [path.resolve("/work/win")],
					system: [],
					after: [],
				},
				forcedIncludes: ["forced.h"],
				defines: { WIN: "1" },
				undefines: [],
			},
		]);
		expect(database.diagnostics.map((diagnostic) => diagnostic.severity)).toEqual(["warning"]);
	});

	it("serves `-I` before `-I-` to quoted includes only, and stops quoted lookup in the includer's directory", () => {
		const [command] = read([
			{ directory: ".", file: "a.c", arguments: ["cc", "-iquote", "q", "-Ipre", "-I-", "-Ipost"] },
		]).commands;

		expect(command?.includes).toEqual({
			includerDirectory: false,
			quote: [path.resolve("/work/q"), path.resolve("/work/pre")],
			user: [path.resolve("/work/post")],
			system: [],
			after: [],
		});
	});

	it("splits a command as its driver's shell would", () => {
		expect(splitCommand('cc  "a b" c\\ d \\"e\\" ""')).toEqual(["cc", "a b", "c d", '"e"', ""]);
		// POSIX single quotes keep everything; inside double quotes a backslash escapes only a few characters.
		expect(splitCommand(`c++ -I'include dir' '\\n' "x\\y" "q\\"z" -c src/main.cpp`)).toEqual([
			"c++",
			"-Iinclude dir",
			"\\n",
			"x\\y",
			'q"z',
			"-c",
			"src/main.cpp",
		]);
		// Windows rules keep a path's backslashes; only a run before a quote is read.
		expect(splitCommand('cl.exe /I"C:\\work\\sdk\\include" /DQ=\\"x\\" "C:\\a b\\\\" ""')).toEqual([
			"cl.exe",
			"/IC:\\work\\sdk\\include",
			'/DQ="x"',
			"C:\\a b\\",
			"",
		]);
	});

	it("reads a command's include directories in time linear in their count", () => {
		const timed = (count: number) => {
			const args = ["cc", ...Array.from({ length: count }, (_, index) => `-Idir${index}`), "a.c"];
			const text = JSON.stringify([{ directory: "/", file: "a.c", arguments: args }]);
			let best = Number.POSITIVE_INFINITY;
			for (let round = 0; round < 3; round++) {
				const started = performance.now();
				readCompileCommands({ module: "compile_commands.json", text, location: "/" });
				best = Math.min(best, performance.now() - started);
			}
			return best;
		};
		// Linear reads 8x; a scan of the list per directory reads 64x.
		expect(timed(16_000) / timed(2_000)).toBeLessThan(24);
	});

	it("answers a database that is not a list of commands with a diagnostic, never a throw", () => {
		const garbled = readCompileCommands({ module: "compile_commands.json", text: "{ nope", location: "/" });
		const deep = readCompileCommands({ module: "compile_commands.json", text: "[".repeat(200_000), location: "/" });

		expect(garbled.commands).toEqual([]);
		expect(garbled.diagnostics.length).toBeGreaterThan(0);
		expect(deep.diagnostics.length).toBeGreaterThan(0);
	});
});
