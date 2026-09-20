/**
 * The path-loaded extension cases, run under `bun test`.
 *
 * **Why this file exists**: jiti's native import/require fast-path defaults to
 * enabled when Bun is detected. Under `bun test` that path handed Pi a factory
 * for a module whose body was still evaluating, so an entrypoint with a
 * module-level `await import(...)` failed with
 * `Cannot access 'x' before initialization`. Node — and therefore vitest —
 * leaves that fast-path off, so the vitest suite alone cannot catch a
 * regression here. This smoke is the Bun-side guard.
 *
 * Lives in `scripts/` rather than `__tests__/` for two reasons: it imports
 * `bun:test`, which vitest would try to load (vitest's include only covers
 * `__tests__/**`), and keeping it out of the typechecked project avoids a
 * dependency on Bun's type definitions.
 *
 * Run with `npm run test:bun`.
 */

import { describe, expect, test } from "bun:test";
import {
	brokenCase,
	loadingCases,
	observeLoad,
	observeLoadFailure,
} from "../__tests__/extension-loading-cases.js";
import { BROKEN_IMPL_MESSAGE } from "../__tests__/fixtures/tla-extension/broken-impl.js";

/** Cold extension loading through jiti is slower under Bun than the 5s default. */
const TIMEOUT_MS = 30_000;

describe("extension loading under Bun — path-loaded entrypoints", () => {
	for (const testCase of loadingCases) {
		test(
			`loads a ${testCase.name}`,
			async () => {
				const observed = await observeLoad(testCase.entry);

				// The regression surfaced here: a TDZ error inside the extension
				// instead of a clean load.
				expect(observed.extensionErrors).toEqual([]);
				expect(observed.extensionCount).toBe(1);

				expect(observed.registeredTools).toContain(testCase.toolName);
				expect(observed.registeredCommands).toEqual(testCase.commandNames);

				if (testCase.labelMarker) {
					const marker = testCase.labelMarker;
					expect(
						observed.registeredToolLabels.some((label) => label.includes(marker)),
					).toBe(true);
				}

				expect(observed.sessionTools).toContain(testCase.toolName);
			},
			TIMEOUT_MS,
		);
	}

	test(
		"still reports a failing implementation as an extension load error",
		async () => {
			const message = await observeLoadFailure(brokenCase);

			expect(message).toBeDefined();
			expect(message).toContain(BROKEN_IMPL_MESSAGE);
			expect(message).not.toContain("before initialization");
		},
		TIMEOUT_MS,
	);
});
