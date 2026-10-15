import type { ModuleAdmission } from "../methods.js";
import { moduleOf } from "../symbolId.js";
import { hashOf } from "./caseSupport.js";
import type { MethodResponse, ProviderSession } from "./providerSession.js";
import type { CaseResult, LifecycleCase, LifecycleFixture } from "./types.js";

////////////////////////////////
//  Lifecycle

/** Which modules a use of `name` binds into. A specifier names a module, so import rows are out. */
function boundModules(facts: MethodResponse<"parseFile">, name: string): string[] {
	const found = new Set<string>();
	for (const reference of facts.references) {
		if (reference.name !== name || reference.role === "import" || reference.role === "export") continue;
		if (reference.binding.status !== "bound") continue;
		const module = moduleOf(reference.binding.symbolId);
		if (module !== null) found.add(module);
	}
	return [...found];
}

/** The control step first: a provider binding nothing across files must not pass while silent. */
async function runLifecycleCase(
	session: ProviderSession,
	testCase: LifecycleCase,
	fixture: LifecycleFixture,
): Promise<CaseResult> {
	const targetText = fixture.files[fixture.target] as string;
	const userText = fixture.files[fixture.user] as string;
	const problems: string[] = [];

	/** Parses the target and settles the index's verdict on it. */
	const settle = async (text: string, reason?: string): Promise<void> => {
		const contentHash = hashOf(text);
		await session.call("parseFile", { module: fixture.target, contentHash, text });
		const verdict: ModuleAdmission = {
			module: fixture.target,
			contentHash,
			outcome: reason === undefined ? { status: "admitted" } : { status: "refused", reason },
		};
		await session.notify("moduleAdmission", verdict);
	};

	/** Where the use lands now. */
	const uses = async (): Promise<string[]> => {
		const facts = await session.call("parseFile", {
			module: fixture.user,
			contentHash: hashOf(userText),
			text: userText,
		});
		return boundModules(facts, fixture.name);
	};

	await settle(targetText);
	if (!(await uses()).includes(fixture.target)) {
		return {
			caseId: testCase.id,
			tier: "binding",
			outcome: "skipped",
			problems: [
				`${fixture.user} does not bind ${fixture.name} into ${fixture.target}, so this provider holds no cross-file state for the case to correct`,
			],
		};
	}

	if (testCase.expect === "keepsAdmitted") {
		await settle(fixture.refusedText, "the index refused these facts");
		if (!(await uses()).includes(fixture.target)) {
			problems.push(
				`after a refused parse of ${fixture.target}, ${fixture.name} no longer binds into it: the refused facts replaced what the index still holds`,
			);
		}
		return { caseId: testCase.id, tier: "binding", outcome: problems.length === 0 ? "passed" : "failed", problems };
	}

	// The index holds nothing for the target: it let the module go, then refused the parse that
	// followed. A provider that kept the refused facts, or read them back off disk, binds anyway.
	//
	// The refused parse is the target's own text, so it DECLARES the name. Refusing text that
	// dropped the name would let a provider holding the refused facts pass, since the use would be
	// unbound either way.
	await session.notify("forgetModule", { module: fixture.target });
	await settle(targetText, "the index refused these facts");
	if ((await uses()).includes(fixture.target)) {
		problems.push(
			`${fixture.name} binds into ${fixture.target} after the index forgot it and refused the parse that followed, so the provider holds facts the index does not`,
		);
	}

	await settle(targetText);
	if (!(await uses()).includes(fixture.target)) {
		problems.push(
			`${fixture.name} no longer binds into ${fixture.target} after an admitted parse, so the refusal withheld it for good`,
		);
	}

	return { caseId: testCase.id, tier: "binding", outcome: problems.length === 0 ? "passed" : "failed", problems };
}

export { runLifecycleCase };
