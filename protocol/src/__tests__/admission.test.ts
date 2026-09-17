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

////////////////////////////////
//  Tests

describe("a refusal puts back what the index still holds", () => {
	it("leaves an admitted parse standing", () => {
		const ledger = new AdmissionLedger<string>();
		ledger.staged("a.fake", "h1", "old");
		expect(ledger.settle(verdict("a.fake", "h1"))).toBeNull();
		expect(ledger.fillable("a.fake")).toBe(true);
	});

	it("puts back what a refused parse displaced", () => {
		const ledger = new AdmissionLedger<string>();
		ledger.staged("a.fake", "h1", "old");
		expect(ledger.settle(verdict("a.fake", "h1", "refused"))).toEqual({ module: "a.fake", facts: "old" });
	});

	// The index holds nothing for a module whose only parse it refused.
	it("puts back nothing where the parse displaced nothing", () => {
		const ledger = new AdmissionLedger<string>();
		ledger.staged("a.fake", "h1", undefined);
		expect(ledger.settle(verdict("a.fake", "h1", "refused"))).toEqual({ module: "a.fake", facts: undefined });
	});

	it("withholds a refused module from a fill until a parse names it again", () => {
		const ledger = new AdmissionLedger<string>();
		ledger.staged("a.fake", "h1", undefined);
		ledger.settle(verdict("a.fake", "h1", "refused"));
		expect(ledger.fillable("a.fake")).toBe(false);
		ledger.staged("a.fake", "h2", undefined);
		expect(ledger.fillable("a.fake")).toBe(true);
	});

	it("withholds a forgotten module, and settles no verdict for it", () => {
		const ledger = new AdmissionLedger<string>();
		ledger.staged("a.fake", "h1", "old");
		ledger.forgotten("a.fake");
		expect(ledger.fillable("a.fake")).toBe(false);
		expect(ledger.settle(verdict("a.fake", "h1", "refused"))).toBeNull();
	});

	// A verdict about bytes the provider has moved past describes a parse a later one replaced.
	it("settles nothing for a hash it did not stage", () => {
		const ledger = new AdmissionLedger<string>();
		ledger.staged("a.fake", "h2", "old");
		expect(ledger.settle(verdict("a.fake", "h1", "refused"))).toBeNull();
		expect(ledger.fillable("a.fake")).toBe(true);
	});

	it("settles nothing for a module it never staged", () => {
		const ledger = new AdmissionLedger<string>();
		expect(ledger.settle(verdict("a.fake", "h1", "refused"))).toBeNull();
		expect(ledger.fillable("a.fake")).toBe(true);
	});

	// One verdict per parse: a repeat describes a parse already settled.
	it("settles one verdict per staged parse", () => {
		const ledger = new AdmissionLedger<string>();
		ledger.staged("a.fake", "h1", "old");
		expect(ledger.settle(verdict("a.fake", "h1", "refused"))).not.toBeNull();
		expect(ledger.settle(verdict("a.fake", "h1", "refused"))).toBeNull();
	});

	it("carries nothing across a reset", () => {
		const ledger = new AdmissionLedger<string>();
		ledger.staged("a.fake", "h1", "old");
		ledger.forgotten("b.fake");
		ledger.reset();
		expect(ledger.fillable("b.fake")).toBe(true);
		expect(ledger.settle(verdict("a.fake", "h1", "refused"))).toBeNull();
	});
});

/**
 * Two parses of one module can be outstanding at once, and after every settlement the provider
 * must hold what the index last admitted, or what it held before the run when nothing was.
 */
describe("two outstanding parses of one module", () => {
	/** `old` held, then `h1` producing `facts1`, then `h2` producing `facts2`. */
	function twoStaged(): AdmissionLedger<string> {
		const ledger = new AdmissionLedger<string>();
		ledger.staged("a.fake", "h1", "old");
		ledger.staged("a.fake", "h2", "facts1");
		return ledger;
	}

	it("holds the first parse when it was admitted and the second refused", () => {
		const ledger = twoStaged();
		expect(ledger.settle(verdict("a.fake", "h1"))).toBeNull();
		expect(ledger.settle(verdict("a.fake", "h2", "refused"))).toEqual({ module: "a.fake", facts: "facts1" });
	});

	it("keeps the second parse when the first was refused and the second admitted", () => {
		const ledger = twoStaged();
		expect(ledger.settle(verdict("a.fake", "h1", "refused"))).toBeNull();
		expect(ledger.settle(verdict("a.fake", "h2"))).toBeNull();
		// Admitted, so the earlier refusal no longer withholds it from a fill.
		expect(ledger.fillable("a.fake")).toBe(true);
	});

	// The defect: keeping one entry per module lost `old`, leaving the provider on facts1.
	it("goes back to what was held before, when both are refused", () => {
		const ledger = twoStaged();
		expect(ledger.settle(verdict("a.fake", "h1", "refused"))).toBeNull();
		expect(ledger.settle(verdict("a.fake", "h2", "refused"))).toEqual({ module: "a.fake", facts: "old" });
		expect(ledger.fillable("a.fake")).toBe(false);
	});

	it("puts nothing back when both are admitted", () => {
		const ledger = twoStaged();
		expect(ledger.settle(verdict("a.fake", "h1"))).toBeNull();
		expect(ledger.settle(verdict("a.fake", "h2"))).toBeNull();
		expect(ledger.fillable("a.fake")).toBe(true);
	});

	it("settles nothing for a hash arriving after its parse was settled", () => {
		const ledger = twoStaged();
		ledger.settle(verdict("a.fake", "h1", "refused"));
		ledger.settle(verdict("a.fake", "h2", "refused"));
		expect(ledger.settle(verdict("a.fake", "h1", "refused"))).toBeNull();
		expect(ledger.settle(verdict("a.fake", "h2"))).toBeNull();
	});

	// Out of order, which the queue does not produce; the oldest outstanding parse is the subject.
	it("settles nothing for the newer parse while the older is outstanding", () => {
		const ledger = twoStaged();
		expect(ledger.settle(verdict("a.fake", "h2", "refused"))).toBeNull();
		expect(ledger.settle(verdict("a.fake", "h1", "refused"))).toBeNull();
	});
});

describe("a forgotten module", () => {
	it("drops every outstanding parse, so no verdict puts one back", () => {
		const ledger = new AdmissionLedger<string>();
		ledger.staged("a.fake", "h1", "old");
		ledger.staged("a.fake", "h2", "facts1");
		ledger.forgotten("a.fake");
		expect(ledger.settle(verdict("a.fake", "h1", "refused"))).toBeNull();
		expect(ledger.settle(verdict("a.fake", "h2", "refused"))).toBeNull();
		expect(ledger.fillable("a.fake")).toBe(false);
	});
});
