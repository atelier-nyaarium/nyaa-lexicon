import { describe, expect, it } from "bun:test";
import { fromText, type SealedRead, sourceReadBytes } from "../sourceRead";
import { testPolicy } from "./testPolicy";

/** Admission controls storage and stamp. */

////////////////////////////////
//  Helpers

const snapshot = testPolicy(".", { secrets: {}, deny: ["denied/**"] }).current;

const text = (module: string, body: string): SealedRead => fromText(() => body)(module);

const missing = (module: string): SealedRead => fromText(() => null)(module);

const binary = (module: string): SealedRead => sourceReadBytes(module, null);

const SECRET = "kind: Secret\ndata:\n  token: VALUE\n";

const CONFIG_MAP = "kind: ConfigMap\ndata:\n  token: VALUE\n";

const stampOf = (module: string) => snapshot.answer(module).stamp;

const admitted = (subject: string | SealedRead) => {
	const { as, stamp } = snapshot.admission(subject);
	return { as, stamp };
};

////////////////////////////////
//  Tests

describe("the admission a snapshot mints", () => {
	it("is plain with no stamp for a module no rule reaches", () => {
		expect(admitted(text("src/a.ts", "export const a = 1;\n"))).toEqual({ as: "plain", stamp: null });
		expect(admitted("src/a.ts")).toEqual({ as: "plain", stamp: null });
	});

	it("follows what the bytes read as under a key-path rule, with one stamp for both", () => {
		expect(admitted(text("deploy.yaml", SECRET))).toEqual({ as: "masked", stamp: stampOf("deploy.yaml") });
		expect(admitted(text("deploy.yaml", CONFIG_MAP))).toEqual({ as: "plain", stamp: stampOf("deploy.yaml") });
		expect(stampOf("deploy.yaml")).not.toBeNull();
	});

	it("keeps only keys of a whole-file secret, and withholds one it cannot read", () => {
		const stamp = stampOf(".env.local");

		expect(admitted(text(".env.local", "TOKEN=VALUE\n"))).toEqual({ as: "keys", stamp });
		expect(admitted(missing(".env.local"))).toEqual({ as: "withheld", stamp });
		expect(admitted(binary(".env.local"))).toEqual({ as: "withheld", stamp });
	});

	it("omits a denied module whatever its bytes", () => {
		const omitted = { as: "omit" as const, stamp: stampOf("denied/x.json") };

		expect(admitted(text("denied/x.json", '{"a":1}'))).toEqual(omitted);
		expect(admitted("denied/x.json")).toEqual(omitted);
	});

	it("counts a module with no text as the answer alone: a key-path rule keeps nothing to hide", () => {
		expect(admitted("deploy.yaml")).toEqual({ as: "plain", stamp: stampOf("deploy.yaml") });
		expect(admitted(missing("deploy.yaml"))).toEqual({ as: "plain", stamp: stampOf("deploy.yaml") });
		expect(admitted(".env.local")).toEqual({ as: "keys", stamp: stampOf(".env.local") });
		expect(admitted(binary("deploy.yaml")).as).toBe("withheld");
	});

	it("names the module it was minted for, which a read carries", () => {
		expect(snapshot.admission("src/a.ts").module).toBe("src/a.ts");
		expect(snapshot.admission(text(".env.local", "A=1\n")).module).toBe(".env.local");
	});
});
