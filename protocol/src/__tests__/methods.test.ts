import { describe, expect, it } from "vitest";
import { isProviderMethod, METHOD_SCHEMAS, PROVIDER_METHODS } from "../methods";
import { BindingSchema, TypeInfoSchema } from "../values";
import { checkCompatibility, isCompatibleProtocol, PROTOCOL_VERSION, parseVersion } from "../version";

////////////////////////////////
//  Tests

describe("method table", () => {
	it("covers every declared method, so a dispatcher cannot silently miss one", () => {
		for (const name of PROVIDER_METHODS) {
			expect(METHOD_SCHEMAS[name], name).toBeDefined();
			expect(METHOD_SCHEMAS[name].request, name).toBeDefined();
			expect(METHOD_SCHEMAS[name].response, name).toBeDefined();
		}
		expect(Object.keys(METHOD_SCHEMAS).sort()).toEqual([...PROVIDER_METHODS].sort());
	});

	it("recognizes exactly the declared names", () => {
		expect(isProviderMethod("parseFile")).toBe(true);
		expect(isProviderMethod("describe")).toBe(false);
		expect(isProviderMethod("")).toBe(false);
	});

	it("carries an additive surface depth through parse and resolution", () => {
		expect(
			METHOD_SCHEMAS.parseFile.request.parse({
				module: "opaque/runtime.js",
				contentHash: "hash",
				text: "",
				depth: "surface",
			}),
		).toMatchObject({ depth: "surface" });
		expect(
			METHOD_SCHEMAS.resolveImport.response.parse({
				status: "external",
				packageName: "example",
				surface: { module: "node_modules/example/index.d.ts" },
			}),
		).toMatchObject({ status: "external", surface: { module: "node_modules/example/index.d.ts" } });
	});

	it("validates a well-formed initialize round trip", () => {
		const response = {
			providerId: "ts-provider",
			language: "typescript",
			extensions: [".ts", ".tsx"],
			protocolVersion: PROTOCOL_VERSION,
			tiers: {
				projectModel: true,
				declarations: true,
				references: true,
				imports: true,
				binding: true,
				types: false,
				literals: false,
				comments: false,
				docs: false,
				metrics: false,
			},
			referenceRoles: ["call", "read", "write"],
		};
		expect(METHOD_SCHEMAS.initialize.response.parse(response)).toMatchObject({ language: "typescript" });
	});

	it("takes a content class from the closed set only, and none means code by omission", () => {
		const base = {
			providerId: "json-provider",
			language: "json",
			extensions: [".json"],
			protocolVersion: PROTOCOL_VERSION,
			tiers: {
				projectModel: false,
				declarations: true,
				references: false,
				imports: false,
				binding: false,
				types: false,
				literals: true,
				comments: true,
				docs: false,
				metrics: false,
			},
		};
		expect(METHOD_SCHEMAS.initialize.response.parse({ ...base, content: "data" })).toMatchObject({
			content: "data",
		});
		expect(METHOD_SCHEMAS.initialize.response.parse(base)).not.toHaveProperty("content");
		expect(METHOD_SCHEMAS.initialize.response.safeParse({ ...base, content: "prose" }).success).toBe(false);
	});

	/**
	 * A tier boolean over a nine-role vocabulary cannot be an unqualified claim.
	 *
	 * A provider that extracts calls only had no way to say so, and two of three did exactly that.
	 * Requiring the roles the moment the tier is claimed turns "references" into a statement of
	 * coverage rather than a flag, and it is the interface refusing the over-claim rather than a
	 * convention asking providers not to make it.
	 */
	it("refuses a provider that claims the references tier without saying which roles it extracts", () => {
		const tiers = {
			projectModel: true,
			declarations: true,
			references: true,
			imports: false,
			binding: false,
			types: false,
			literals: false,
			comments: false,
			docs: false,
			metrics: false,
		};
		const base = { providerId: "p", language: "toy", extensions: [".t"], protocolVersion: PROTOCOL_VERSION };

		expect(METHOD_SCHEMAS.initialize.response.safeParse({ ...base, tiers }).success).toBe(false);
		// Every tier is a required claim: a provider silent about one is not a provider claiming false.
		const { comments: _dropped, ...withoutComments } = tiers;
		expect(
			METHOD_SCHEMAS.initialize.response.safeParse({
				...base,
				tiers: withoutComments,
				referenceRoles: ["call"],
			}).success,
		).toBe(false);
		expect(METHOD_SCHEMAS.initialize.response.safeParse({ ...base, tiers, referenceRoles: [] }).success).toBe(
			false,
		);
		expect(METHOD_SCHEMAS.initialize.response.safeParse({ ...base, tiers, referenceRoles: ["call"] }).success).toBe(
			true,
		);
	});

	// Not claiming the tier means there is nothing to qualify, so silence stays legal.
	it("allows a provider that does not claim the references tier to say nothing about roles", () => {
		const response = {
			providerId: "p",
			language: "toy",
			extensions: [".t"],
			protocolVersion: PROTOCOL_VERSION,
			tiers: {
				projectModel: true,
				declarations: true,
				references: false,
				imports: false,
				binding: false,
				types: false,
				literals: false,
				comments: false,
				docs: false,
				metrics: false,
			},
		};
		expect(METHOD_SCHEMAS.initialize.response.safeParse(response).success).toBe(true);
	});

	it("refuses an initialize response missing a tier, since tiers must be stated not guessed", () => {
		const missing = {
			providerId: "p",
			language: "python",
			extensions: [".py"],
			protocolVersion: PROTOCOL_VERSION,
			tiers: { projectModel: true, declarations: true, references: true, imports: true, binding: true },
		};
		expect(METHOD_SCHEMAS.initialize.response.safeParse(missing).success).toBe(false);
	});
});

describe("uncertainty is representable, certainty-without-evidence is not", () => {
	it("accepts a provider that answers unknown with a reason", () => {
		const unknown = { status: "unknown", reason: "NotImplemented" };
		expect(TypeInfoSchema.parse(unknown)).toEqual(unknown);
	});

	it("refuses an unknown with no reason", () => {
		expect(TypeInfoSchema.safeParse({ status: "unknown" }).success).toBe(false);
		expect(BindingSchema.safeParse({ status: "unbound" }).success).toBe(false);
	});

	it("refuses a reason outside the closed set", () => {
		expect(TypeInfoSchema.safeParse({ status: "unknown", reason: "dunno" }).success).toBe(false);
	});

	it("refuses a bound binding with no symbol", () => {
		expect(BindingSchema.safeParse({ status: "bound", provenance: "bound" }).success).toBe(false);
	});

	it("requires ambiguous to carry more than one candidate, or it is not ambiguous", () => {
		const one = { status: "ambiguous", candidates: ["a"], provenance: "nameMatched" };
		const two = { status: "ambiguous", candidates: ["a", "b"], provenance: "nameMatched" };
		expect(BindingSchema.safeParse(one).success).toBe(false);
		expect(BindingSchema.safeParse(two).success).toBe(true);
	});

	it("requires an inferred type to say what it was inferred from", () => {
		expect(TypeInfoSchema.safeParse({ status: "inferred", display: "number" }).success).toBe(false);
		expect(
			TypeInfoSchema.safeParse({ status: "inferred", display: "number", basis: "return statements" }).success,
		).toBe(true);
	});
});

describe("version negotiation", () => {
	it("parses a plain version and refuses anything else", () => {
		expect(parseVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
		expect(parseVersion("1.2")).toBeNull();
		expect(parseVersion("1.2.3-rc1")).toBeNull();
	});

	it("refuses a component past the safe integer range, which would merge two versions", () => {
		expect(parseVersion("9007199254740993.0.0")).toBeNull();
		const r = checkCompatibility("9007199254740993.0.0", "9007199254740992.0.0");
		expect(r.ok === false && r.reason).toBe("malformed");
	});

	it("refuses leading zeros, so one version has one spelling", () => {
		expect(parseVersion("01.02.03")).toBeNull();
	});

	it("accepts its own version with no note", () => {
		expect(checkCompatibility(PROTOCOL_VERSION)).toEqual({ ok: true });
	});

	it("accepts either side being older or newer within a major, since changes are additive", () => {
		const older = checkCompatibility("1.1.0", "1.4.0");
		const newer = checkCompatibility("1.9.0", "1.4.0");
		expect(older.ok && older.note).toMatch(/older/);
		expect(newer.ok && newer.note).toMatch(/newer/);
	});

	it("refuses a different major and says what each side speaks", () => {
		const r = checkCompatibility("2.0.0", "1.4.0");
		expect(r.ok).toBe(false);
		expect(r.ok === false && r.reason).toBe("majorMismatch");
		expect(r.ok === false && r.detail).toContain("2.0.0");
	});

	it("separates malformed from incompatible, since they need different fixes", () => {
		const r = checkCompatibility("banana", "1.0.0");
		expect(r.ok === false && r.reason).toBe("malformed");
	});

	it("ignores patch differences entirely", () => {
		expect(isCompatibleProtocol("1.0.99", "1.0.0")).toBe(true);
	});
});
