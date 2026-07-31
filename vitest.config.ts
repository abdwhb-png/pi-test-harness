import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["__tests__/**/*.test.ts"],
		// These tests boot real Pi integration sessions; 5s (Vitest default) is
		// too tight for cold jiti/extension loading and produced flaky RED runs.
		testTimeout: 15_000,
	},
});
