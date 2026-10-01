import { expect, it } from "bun:test";
import { type MoveMember, moveOrder } from "../moveOrder";

function member(name: string, uses: string[] = [], inside: string[] = []): MoveMember {
	return { symbolId: name, name, closure: [name, ...inside], uses };
}

it("moves each declaration after the ones it uses, nested ones with their owner, and refuses a cycle", () => {
	const names = (members: MoveMember[]) => members.map((each) => each.name);
	const set = [
		member("render", ["Props", "helper", "outside"], ["render.local"]),
		member("render.local"),
		member("helper", ["Props"]),
		member("Props"),
	];
	const ordered = moveOrder(set);

	expect({
		order: "order" in ordered ? names(ordered.order) : ordered,
		cycle: moveOrder([member("a", ["b"]), member("b", ["a"]), member("c")]),
	}).toEqual({
		order: ["Props", "helper", "render"],
		cycle: { cycle: ["a", "b", "a"] },
	});
});
