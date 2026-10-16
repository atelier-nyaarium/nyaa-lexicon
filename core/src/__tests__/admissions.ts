import type { AdmittedAs, SecretAdmission, StoredFailure } from "../secretPolicy";
import type { FileWrite, IndexStore, SurfaceChange } from "../store";

/** Policy-shaped admission for tests. */
export function admit(module: string, as: AdmittedAs = "plain", stamp: string | null = null): SecretAdmission {
	return { module, stamp, as } as SecretAdmission;
}

/** Policy-shaped failure for tests. */
export function failed(reason: string): StoredFailure {
	return reason as StoredFailure;
}

/** Writes plain module facts. */
export function writePlain(store: IndexStore, facts: FileWrite): SurfaceChange | null {
	return store.replaceFile({ ...facts, admission: admit(facts.module) });
}

/** Forgets a plain module. */
export function forgetPlain(store: IndexStore, module: string): boolean {
	return store.forgetFile(module, admit(module));
}

/** Records a plain module failure. */
export function failPlain(store: IndexStore, module: string, reason: string): void {
	store.recordFailure(module, failed(reason), admit(module));
}
