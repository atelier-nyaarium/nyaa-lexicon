// Runs the corpus against a provider and prints the report.
//
//   bun run protocol/src/conformance/cli.ts -- bun run providers/typescript/src/main.ts
//
// A provider team runs this without the core existing, which is the point of the suite.

import { loadCorpus } from "./corpus.js";
import { loadMoveCases } from "./moveCorpus.js";
import { loadGdscriptMoveCases } from "./moveCorpusGdscript.js";
import { formatReport, runSuite } from "./runner.js";

async function main(argv: string[]): Promise<void> {
	if (argv.length === 0) {
		console.error("usage: cli.ts <provider command...>");
		process.exit(2);
	}

	const report = await runSuite({
		command: argv,
		cases: loadCorpus(),
		moveCases: [...loadMoveCases(), ...loadGdscriptMoveCases()],
	});
	console.log(formatReport(report));
	// Skipped is not failure. Stalled is neither pass nor failure: 3.
	process.exit(report.failed > 0 ? 1 : report.stalled > 0 ? 3 : 0);
}

if (import.meta.main) await main(process.argv.slice(2));
