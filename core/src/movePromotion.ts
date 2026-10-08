import type { MoveDependency, Promoted, RefactorIssue } from "@nyaa-lexicon/protocol";

export function promoteDependency(dependency: MoveDependency, promote: boolean): MoveDependency {
	const origin = dependency.origin;
	return promote && origin.kind === "sourceModule" && origin.exported === false
		? { ...dependency, origin: { ...origin, promoted: true } }
		: dependency;
}

export function promotedFrom(dependencies: readonly MoveDependency[]): Promoted[] {
	const found = new Map<string, Promoted>();
	for (const dependency of dependencies) {
		const origin = dependency.origin;
		if (origin.kind === "sourceModule" && origin.promoted) {
			found.set(origin.symbolId, { symbolId: origin.symbolId, name: origin.name });
		}
	}
	return [...found.values()];
}

/** An answer's `promoted`, absent when nothing was. */
export function promotedField(promoted: readonly Promoted[] | undefined): { promoted?: Promoted[] } {
	return promoted !== undefined && promoted.length > 0 ? { promoted: [...promoted] } : {};
}

export function unacknowledgedPromotions(
	ids: readonly string[],
	acknowledged: readonly string[],
	promoted: readonly Promoted[],
	module: string,
): RefactorIssue[] {
	const accepted = new Set(acknowledged);
	const names = new Map(promoted.map((item) => [item.symbolId, item.name]));
	return ids.flatMap((symbolId) =>
		accepted.has(symbolId)
			? []
			: [{ kind: "PrivateSibling", detail: `${names.get(symbolId) ?? symbolId} is not exported`, module }],
	);
}
