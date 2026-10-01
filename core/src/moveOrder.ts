// The order a set of declarations moves in: each after what it uses, so no move strands a sibling.

////////////////////////////////
//  Interfaces & Types

export interface MoveMember {
	symbolId: string;
	name: string;
	/** Its own id and every id declared inside it. */
	closure: readonly string[];
	/** Ids its text uses from outside its closure. */
	uses: readonly string[];
}

/** `cycle` names members that use each other, the first repeated last. */
export type MoveOrder = { order: MoveMember[] } | { cycle: string[] };

////////////////////////////////
//  Functions & Helpers

/** A member inside another moves with it; the rest move after the members they use, else in the order given. */
export function moveOrder(members: readonly MoveMember[]): MoveOrder {
	const roots = members.filter(
		(member) => !members.some((other) => other !== member && other.closure.includes(member.symbolId)),
	);
	const owner = new Map<string, MoveMember>();
	for (const root of roots) for (const id of root.closure) owner.set(id, root);

	const order: MoveMember[] = [];
	const done = new Set<MoveMember>();
	const visit = (member: MoveMember, path: MoveMember[]): string[] | null => {
		if (done.has(member)) return null;
		const looped = path.indexOf(member);
		if (looped >= 0) return [...path.slice(looped), member].map((each) => each.name);
		for (const id of member.uses) {
			const used = owner.get(id);
			if (used === undefined || used === member) continue;
			const cycle = visit(used, [...path, member]);
			if (cycle !== null) return cycle;
		}
		done.add(member);
		order.push(member);
		return null;
	};
	for (const root of roots) {
		const cycle = visit(root, []);
		if (cycle !== null) return { cycle };
	}
	return { order };
}
