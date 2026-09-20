/**
 * Extension loading through `createTestSession({ extensions: [...] })`.
 *
 * Covers the path-loaded loader boundary, which the rest of the suite only
 * exercises through `extensionFactories` or a packed package. The regression
 * under guard: an entrypoint whose factory is produced by a module-level
 * `await import(...)` must not be handed to Pi before its module body finishes
 * evaluating — that surfaces as a TDZ ReferenceError inside the extension.
 *
 * Assertions deliberately check the *registrations* (tool, command, and a value
 * produced inside the awaited module), not merely "no error thrown", so a
 * loader that skips the awaited module cannot pass.
 *
 * The cases are shared with `__tests__/extension-loading-bun.test.ts`, which
 * runs them under `bun test` — the runner where the regression originally
 * reproduced and where jiti's native import fast-path is enabled by default.
 */

import { describe, it, expect } from "vitest";
import {
	brokenCase,
	loadingCases,
	observeLoad,
	observeLoadFailure,
} from "./extension-loading-cases.js";
import { BROKEN_IMPL_MESSAGE } from "./fixtures/tla-extension/broken-impl.js";

describe("extension loading — path-loaded entrypoints", () => {
	for (const testCase of loadingCases) {
		it(`loads a ${testCase.name}`, async () => {
			const observed = await observeLoad(testCase.entry);

			expect(observed.extensionErrors).toEqual([]);
			expect(observed.extensionCount).toBe(1);

			// The extension's own registrations.
			expect(observed.registeredTools).toContain(testCase.toolName);
			expect(observed.registeredCommands).toEqual(testCase.commandNames);

			// A value produced inside the awaited module reached the tool label.
			if (testCase.labelMarker) {
				const marker = testCase.labelMarker;
				expect(
					observed.registeredToolLabels.some((label) => label.includes(marker)),
				).toBe(true);
			}

			// The tool reaches the real session tool registry, not just the loader.
			expect(observed.sessionTools).toContain(testCase.toolName);
		});
	}

	it("still reports a failing implementation as an extension load error", async () => {
		const message = await observeLoadFailure(brokenCase);

		expect(message).toBeDefined();
		expect(message).toContain(BROKEN_IMPL_MESSAGE);
		// A load failure must be the extension's own error, never a loader-induced
		// TDZ from handing Pi a module whose body has not finished evaluating.
		expect(message).not.toContain("before initialization");
	});
});
