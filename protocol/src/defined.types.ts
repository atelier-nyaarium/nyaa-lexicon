// Compile-time half of `defined`'s contract: what the compiler must still refuse.
//
// Asserted by tsc rather than by a test, since the claim IS a type error. Each `@ts-expect-error`
// fails the build the day its error stops happening, which is the day the helper began hiding a
// mistake the spread it replaced would have caught.

import { defined } from "./defined.js";

interface Fact {
	symbolId: string;
	name: string;
	exported: boolean;
	signature?: string;
	containerId?: string;
}

const signature: string | undefined = "sig";
const containerId: string | undefined = undefined;
const name: string | undefined = "n";

/** The intended use, and the only one here that compiles. */
export const composed: Fact = {
	symbolId: "a",
	name: "n",
	exported: true,
	...defined({ signature, containerId }),
};

// @ts-expect-error a required field left out is still missing
export const missingRequired: Fact = {
	symbolId: "a",
	exported: true,
	...defined({ signature }),
};

// @ts-expect-error a required field routed through here is only maybe-present, which is not enough
export const requiredThroughHelper: Fact = {
	symbolId: "a",
	exported: true,
	...defined({ name, signature }),
};

// @ts-expect-error an optional field's type is still checked
export const wrongType: Fact = {
	symbolId: "a",
	name: "n",
	exported: true,
	...defined({ signature: 42 }),
};
