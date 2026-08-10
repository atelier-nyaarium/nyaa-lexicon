import { describe, expect, it } from "vitest";
import { modulesFor, type ProviderClaims, routeModule } from "../routing";

////////////////////////////////
//  Helpers

const TS: ProviderClaims = { providerId: "ts", language: "typescript", extensions: [".ts", ".tsx"] };
const GD: ProviderClaims = {
	providerId: "gd",
	language: "gdscript",
	extensions: [".gd", ".tscn"],
	filenames: ["project.godot"],
};

function route(module: string, providers: ProviderClaims[] = [TS, GD]) {
	return routeModule(module, providers);
}

////////////////////////////////
//  Tests

describe("routing a module", () => {
	it("routes by extension", () => {
		expect(route("src/cart.ts")).toEqual({ owned: true, providerId: "ts" });
		expect(route("game/player.gd")).toEqual({ owned: true, providerId: "gd" });
	});

	it("matches an extension regardless of case, since two filesystems disagree about it", () => {
		expect(route("src/Cart.TS")).toEqual({ owned: true, providerId: "ts" });
	});

	it("routes an exact filename that has no useful extension", () => {
		expect(route("project.godot")).toEqual({ owned: true, providerId: "gd" });
		expect(route("game/project.godot")).toEqual({ owned: true, providerId: "gd" });
	});

	it("prefers an exact filename over an extension claim", () => {
		const greedy: ProviderClaims = { providerId: "other", language: "x", extensions: [".godot"] };
		expect(route("project.godot", [greedy, GD])).toEqual({ owned: true, providerId: "gd" });
	});

	it("reports an unclaimed file rather than guessing an owner", () => {
		expect(route("README.md")).toEqual({ owned: false, reason: "unclaimed" });
	});

	it("treats a dotfile as having no extension, since the dot is its whole name", () => {
		const dotClaimer: ProviderClaims = { providerId: "x", language: "x", extensions: [".gitignore"] };
		expect(route(".gitignore", [dotClaimer])).toEqual({ owned: false, reason: "unclaimed" });
	});

	it("reports a contested file rather than letting registration order decide", () => {
		const rival: ProviderClaims = { providerId: "other", language: "y", extensions: [".ts"] };
		expect(route("src/a.ts", [TS, rival])).toEqual({
			owned: false,
			reason: "contested",
			providerIds: ["other", "ts"],
		});
	});

	it("answers the same regardless of the order providers were registered", () => {
		const rival: ProviderClaims = { providerId: "other", language: "y", extensions: [".ts"] };
		expect(route("src/a.ts", [TS, rival])).toEqual(route("src/a.ts", [rival, TS]));
	});

	it("answers unclaimed when no provider is registered at all", () => {
		expect(route("src/a.ts", [])).toEqual({ owned: false, reason: "unclaimed" });
	});
});

describe("modulesFor", () => {
	it("selects only the modules one provider owns", () => {
		const modules = ["src/a.ts", "game/b.gd", "README.md", "project.godot"];
		expect(modulesFor("gd", modules, [TS, GD])).toEqual(["game/b.gd", "project.godot"]);
	});

	it("excludes a contested module from both providers, so neither indexes it twice", () => {
		const rival: ProviderClaims = { providerId: "other", language: "y", extensions: [".ts"] };
		expect(modulesFor("ts", ["src/a.ts"], [TS, rival])).toEqual([]);
		expect(modulesFor("other", ["src/a.ts"], [TS, rival])).toEqual([]);
	});
});
