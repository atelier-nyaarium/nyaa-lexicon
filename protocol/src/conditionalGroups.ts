export interface ConditionalDirectiveSpan {
	start: number;
	end: number;
	keyword: string;
}

export interface ConditionalBranchSpan {
	start: number;
	end: number;
}

export interface ConditionalGroup {
	ifIndex: number;
	branches: ConditionalBranchSpan[];
	parent: ConditionalGroup | undefined;
	closed: boolean;
	end: number;
	children: ConditionalGroup[];
	residue: string[];
	keptBranches?: number[];
	resolvable: boolean;
}

export type ConditionalIssue =
	| { kind: "unexpected-branch"; index: number; keyword: string }
	| { kind: "unexpected-end"; index: number }
	| { kind: "unclosed"; index: number };

export interface ConditionalResolution {
	groups: ConditionalGroup[];
	issues: ConditionalIssue[];
	removedBranches: ConditionalBranchSpan[];
}

interface ConditionalResolutionOptions {
	directives: readonly ConditionalDirectiveSpan[];
	tokenCount: number;
	directiveTokens: ReadonlySet<number>;
	firstConditionIsZero: (index: number) => boolean;
	delimiterAt: (index: number) => string;
	onStep?: () => void;
}

const DELIMITER_OPENERS: ReadonlyMap<string, string> = new Map([
	[")", "("],
	["]", "["],
	["}", "{"],
]);

function pushDelimiter(residue: string[], value: string): void {
	const opener = DELIMITER_OPENERS.get(value);
	if (opener !== undefined) {
		if (residue.at(-1) === opener) residue.pop();
		else residue.push(value);
		return;
	}
	if (value === "(" || value === "[" || value === "{") residue.push(value);
}

function branchResidues(
	group: ConditionalGroup,
	directiveTokens: ReadonlySet<number>,
	delimiterAt: (index: number) => string,
	onStep?: () => void,
): string[][] {
	let child = 0;
	return group.branches.map((branch) => {
		const residue: string[] = [];
		for (let index = branch.start; index < branch.end; index++) {
			onStep?.();
			while (child < group.children.length && (group.children[child] as ConditionalGroup).ifIndex < index)
				child++;
			const nested = group.children[child];
			if (nested !== undefined && nested.ifIndex === index) {
				for (const value of nested.residue) pushDelimiter(residue, value);
				index = nested.end - 1;
				child++;
				continue;
			}
			if (!directiveTokens.has(index)) pushDelimiter(residue, delimiterAt(index));
		}
		return residue;
	});
}

export function resolveConditionalGroups(options: ConditionalResolutionOptions): ConditionalResolution {
	const groups: ConditionalGroup[] = [];
	const stack: ConditionalGroup[] = [];
	const issues: ConditionalIssue[] = [];
	for (const directive of options.directives) {
		if (["if", "ifdef", "ifndef"].includes(directive.keyword)) {
			const group: ConditionalGroup = {
				ifIndex: directive.start,
				branches: [{ start: directive.end, end: options.tokenCount }],
				parent: stack.at(-1),
				closed: false,
				end: options.tokenCount,
				children: [],
				residue: [],
				resolvable: false,
			};
			group.parent?.children.push(group);
			groups.push(group);
			stack.push(group);
			continue;
		}
		if (["elif", "else"].includes(directive.keyword)) {
			const group = stack.at(-1);
			if (group === undefined) {
				issues.push({ kind: "unexpected-branch", index: directive.start, keyword: directive.keyword });
				continue;
			}
			(group.branches.at(-1) as ConditionalBranchSpan).end = directive.start;
			group.branches.push({ start: directive.end, end: options.tokenCount });
			continue;
		}
		if (directive.keyword !== "endif") continue;
		const group = stack.pop();
		if (group === undefined) {
			issues.push({ kind: "unexpected-end", index: directive.start });
			continue;
		}
		(group.branches.at(-1) as ConditionalBranchSpan).end = directive.start;
		group.closed = true;
		group.end = directive.end;
	}
	for (const group of stack) issues.push({ kind: "unclosed", index: group.ifIndex });
	for (const group of groups)
		group.resolvable = group.closed && (group.parent === undefined || group.parent.resolvable);

	const removedBranches: ConditionalBranchSpan[] = [];
	for (const group of groups.toReversed()) {
		if (!group.resolvable) continue;
		const residues = branchResidues(group, options.directiveTokens, options.delimiterAt, options.onStep);
		const allWhole = residues.every((residue) => residue.length === 0);
		const activeBranch = options.firstConditionIsZero(group.ifIndex) ? 1 : 0;
		const kept: string[] = [];
		const keptBranches: number[] = [];
		for (const [branch, segment] of group.branches.entries()) {
			const keep = allWhole ? !(activeBranch === 1 && branch === 0) : branch === activeBranch;
			if (!keep) {
				removedBranches.push(segment);
				continue;
			}
			keptBranches.push(branch);
			for (const value of residues[branch] as string[]) pushDelimiter(kept, value);
		}
		group.keptBranches = keptBranches;
		group.residue = kept;
	}
	return { groups, issues, removedBranches };
}
