import { describe, expect, it } from "bun:test";
import { AdmissionLedger, type ModuleAdmission } from "../admission";
import { NOTIFICATION_SCHEMAS } from "../methods";

////////////////////////////////
//  Functions & Helpers

/** Parsed as the wire parses it, so no case asserts on a verdict a provider cannot receive. */
function verdict(module: string, contentHash: string, reason?: string): ModuleAdmission {
	return NOTIFICATION_SCHEMAS.moduleAdmission.parse({
		module,
		contentHash,
		outcome: reason === undefined ? { status: "admitted" } : { status: "refused", reason },
	});
}

/** A provider holding one string per module, parsing through the ledger as the kit drives it. */
function provider(initial: Record<string, string> = {}) {
	const held = new Map(Object.entries(initial));
	const ledger = new AdmissionLedger<string>({
		snapshot: (module) => held.get(module),
		restore: (module, facts) => {
			if (facts === undefined) held.delete(module);
			else held.set(module, facts);
		},
	});
	return {
		ledger,
		held: (module = "a.fake") => held.get(module),
		parse: (contentHash: string, facts: string, module = "a.fake") => {
			ledger.staged(module, contentHash);
			held.set(module, facts);
		},
		install: (facts: string, module = "a.fake") => held.set(module, facts),
	};
}

////////////////////////////////
//  Tests

describe("a refusal puts back what the index still holds", () => {
	it("leaves an admitted parse standing", () => {
		const p = provider({ "a.fake": "old" });
		p.parse("h1", "new");
		p.ledger.settle(verdict("a.fake", "h1"));
		expect({ held: p.held(), fillable: p.ledger.fillable("a.fake") }).toEqual({ held: "new", fillable: true });
	});

	it("puts back what a refused parse displaced, and nothing where it displaced nothing", () => {
		const displaced = provider({ "a.fake": "old" });
		displaced.parse("h1", "new");
		displaced.ledger.settle(verdict("a.fake", "h1", "refused"));
		const fresh = provider();
		fresh.parse("h1", "new");
		fresh.ledger.settle(verdict("a.fake", "h1", "refused"));

		expect([displaced.held(), fresh.held()]).toEqual(["old", undefined]);
	});

	it("withholds a refused module from a fill until a parse names it again", () => {
		const p = provider();
		p.parse("h1", "new");
		p.ledger.settle(verdict("a.fake", "h1", "refused"));
		const refused = p.ledger.fillable("a.fake");
		p.parse("h2", "newer");
		expect([refused, p.ledger.fillable("a.fake")]).toEqual([false, true]);
	});

	it("withholds a forgotten module, and settles no verdict for it", () => {
		const p = provider({ "a.fake": "old" });
		p.parse("h1", "new");
		p.ledger.forgotten("a.fake");
		p.ledger.settle(verdict("a.fake", "h1", "refused"));
		expect({ held: p.held(), fillable: p.ledger.fillable("a.fake") }).toEqual({ held: "new", fillable: false });
	});

	// A verdict about bytes the provider has moved past describes a parse a later one replaced.
	it("settles nothing for a hash it did not stage, a module it never staged, or a repeat", () => {
		const p = provider({ "a.fake": "old" });
		p.parse("h2", "new");
		p.ledger.settle(verdict("a.fake", "h1", "refused"));
		p.ledger.settle(verdict("b.fake", "h1", "refused"));
		const afterStrays = p.held();
		p.ledger.settle(verdict("a.fake", "h2", "refused"));
		p.install("reparsed");
		p.ledger.settle(verdict("a.fake", "h2", "refused"));
		expect({ afterStrays, afterRepeat: p.held(), bFillable: p.ledger.fillable("b.fake") }).toEqual({
			afterStrays: "new",
			afterRepeat: "reparsed",
			bFillable: true,
		});
	});

	it("carries nothing across a reset", () => {
		const p = provider({ "a.fake": "old" });
		p.parse("h1", "new");
		p.ledger.forgotten("b.fake");
		p.ledger.reset();
		p.ledger.settle(verdict("a.fake", "h1", "refused"));
		expect({ held: p.held(), bFillable: p.ledger.fillable("b.fake") }).toEqual({ held: "new", bFillable: true });
	});
});

/**
 * Two parses of one module can be outstanding at once, and after every settlement the provider
 * must hold what the index last admitted, or what it held before the run when nothing was.
 */
describe("two outstanding parses of one module", () => {
	/** `old` held, then `h1` producing `facts1`, then `h2` producing `facts2`. */
	function twoStaged() {
		const p = provider({ "a.fake": "old" });
		p.parse("h1", "facts1");
		p.parse("h2", "facts2");
		return p;
	}

	it("holds what the index last admitted, in every order of verdicts", () => {
		const outcomes = (
			[
				[undefined, "refused"],
				["refused", undefined],
				["refused", "refused"],
				[undefined, undefined],
			] as const
		).map(([first, second]) => {
			const p = twoStaged();
			p.ledger.settle(verdict("a.fake", "h1", first));
			p.ledger.settle(verdict("a.fake", "h2", second));
			return [p.held(), p.ledger.fillable("a.fake")];
		});

		expect(outcomes).toEqual([
			["facts1", false],
			["facts2", true],
			["old", false],
			["facts2", true],
		]);
	});

	// Out of order, which the queue does not produce; the oldest outstanding parse is the subject.
	it("settles nothing for the newer parse while the older is outstanding", () => {
		const p = twoStaged();
		p.ledger.settle(verdict("a.fake", "h2", "refused"));
		expect(p.held()).toBe("facts2");
	});

	it("drops every outstanding parse when forgotten, so no verdict puts one back", () => {
		const p = twoStaged();
		p.ledger.forgotten("a.fake");
		p.ledger.settle(verdict("a.fake", "h1", "refused"));
		p.ledger.settle(verdict("a.fake", "h2", "refused"));
		expect({ held: p.held(), fillable: p.ledger.fillable("a.fake") }).toEqual({ held: "facts2", fillable: false });
	});
});

describe("a probe", () => {
	it("answers from the candidate, then holds what it held before, on every path", async () => {
		const p = provider({ "a.fake": "admitted" });
		const answered = p.ledger.probe("a.fake", () => {
			p.install("candidate");
			return p.held();
		});
		const afterAnswer = p.held();
		const thrown = (() => {
			try {
				p.ledger.probe("a.fake", () => {
					p.install("candidate");
					throw new Error("does not parse");
				});
			} catch {
				return p.held();
			}
		})();
		const rejected = await p.ledger
			.probe("a.fake", async () => {
				p.install("candidate");
				throw new Error("extractor failed");
			})
			.catch(() => p.held());

		expect({ answered, afterAnswer, thrown, rejected }).toEqual({
			answered: "candidate",
			afterAnswer: "admitted",
			thrown: "admitted",
			rejected: "admitted",
		});
	});

	it("stages nothing, so the verdict for a parse outstanding across it still settles", () => {
		const p = provider({ "a.fake": "old" });
		p.parse("h1", "new");
		p.ledger.probe("a.fake", () => p.install("candidate"));
		const afterProbe = p.held();
		p.ledger.settle(verdict("a.fake", "h1", "refused"));
		expect([afterProbe, p.held()]).toEqual(["new", "old"]);
	});
});
