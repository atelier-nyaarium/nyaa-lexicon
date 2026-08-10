// Traversals over the reference graph.
//
// The store holds edges and nothing else, deliberately, so anything needing to walk them lives
// here. Every answer is bounded by what BINDING reached, which is why each one carries that caveat
// rather than reading as a fact about the code.

////////////////////////////////
//  Interfaces & Types

export interface Edge {
	from: string;
	to: string;
}

export interface Cycle {
	/** Members, in no meaningful order. A cycle has no first element. */
	members: string[];
}

////////////////////////////////
//  Functions & Helpers

/**
 * Strongly connected components with more than one member, plus real self-loops.
 *
 * Tarjan's algorithm, written iteratively. A recursive one is shorter and blows the stack on a real
 * workspace: this graph has as many nodes as the codebase has symbols, and a deep chain is ordinary
 * rather than pathological.
 *
 * A single symbol is only a cycle when it genuinely references itself, so ordinary recursion is
 * reported and a symbol merely sitting alone is not.
 */
export function findCycles(edges: Edge[]): Cycle[] {
	const out = new Map<string, string[]>();
	const selfLoops = new Set<string>();
	for (const edge of edges) {
		if (edge.from === edge.to) selfLoops.add(edge.from);
		const list = out.get(edge.from);
		if (list === undefined) out.set(edge.from, [edge.to]);
		else list.push(edge.to);
	}

	const index = new Map<string, number>();
	const low = new Map<string, number>();
	const onStack = new Set<string>();
	const stack: string[] = [];
	const cycles: Cycle[] = [];
	let counter = 0;

	for (const root of out.keys()) {
		if (index.has(root)) continue;

		// Each frame carries how far through its neighbours it has walked, which is what the call
		// stack would have held.
		const work: Array<{ node: string; next: number }> = [{ node: root, next: 0 }];
		index.set(root, counter);
		low.set(root, counter);
		counter++;
		stack.push(root);
		onStack.add(root);

		while (work.length > 0) {
			const frame = work[work.length - 1] as { node: string; next: number };
			const neighbours = out.get(frame.node) ?? [];

			if (frame.next < neighbours.length) {
				const neighbour = neighbours[frame.next] as string;
				frame.next++;
				if (!index.has(neighbour)) {
					index.set(neighbour, counter);
					low.set(neighbour, counter);
					counter++;
					stack.push(neighbour);
					onStack.add(neighbour);
					work.push({ node: neighbour, next: 0 });
				} else if (onStack.has(neighbour)) {
					low.set(frame.node, Math.min(low.get(frame.node) ?? 0, index.get(neighbour) ?? 0));
				}
				continue;
			}

			work.pop();
			const parent = work[work.length - 1];
			if (parent !== undefined) {
				low.set(parent.node, Math.min(low.get(parent.node) ?? 0, low.get(frame.node) ?? 0));
			}

			if (low.get(frame.node) === index.get(frame.node)) {
				const members: string[] = [];
				for (;;) {
					const popped = stack.pop();
					if (popped === undefined) break;
					onStack.delete(popped);
					members.push(popped);
					if (popped === frame.node) break;
				}
				if (members.length > 1 || (members.length === 1 && selfLoops.has(members[0] as string))) {
					cycles.push({ members });
				}
			}
		}
	}
	return cycles;
}
