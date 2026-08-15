import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["**/__tests__/**/*.test.ts"],
		// temp/ holds cloned corpora, whose own test suites must never run as ours.
		exclude: ["**/node_modules/**", "**/dist/**", "temp/**"],
		environment: "node",
	},
});
