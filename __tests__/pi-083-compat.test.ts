/**
 * Pi 0.83 compatibility tests.
 *
 * These tests verify that the harness works correctly with Pi 0.83 APIs:
 *   - ModelRuntime isolation (no credentials, no ~/.pi touch)
 *   - Public Agent APIs (streamFunction, state.tools, waitForIdle)
 *   - AgentSession hooks (beforeToolCall / afterToolCall installed by AgentSession)
 *   - ExtensionUIContext with new 0.83 members
 *   - AgentSession typed on TestSession.session
 */

import { describe, it, expect, afterEach } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	createTestSession,
	when,
	says,
	calls,
	type TestSession,
} from "../src/index.js";

describe("Pi 0.83 compat — isolated session", () => {
	it("dummy runtime API key refresh is offline (no network hang)", async () => {
		// Regression: ModelRuntime.create's initial refresh is offline, but
		// setRuntimeApiKey(provider, key) without options defaults
		// refreshOptions.allowNetwork to modelNetworkEnabled, which is true
		// when PI_OFFLINE is unset — so the dummy-key call could trigger a
		// remote availability refresh and hang fresh processes.
		type RefreshOptions = Parameters<
			typeof ModelRuntime.prototype.setRuntimeApiKey
		>[2];
		const original = ModelRuntime.prototype.setRuntimeApiKey;
		const captured: RefreshOptions[] = [];
		ModelRuntime.prototype.setRuntimeApiKey = function (
			providerId,
			apiKey,
			refreshOptions,
		) {
			captured.push(refreshOptions);
			return original.call(this, providerId, apiKey, refreshOptions);
		};

		let t: TestSession | undefined;
		try {
			t = await createTestSession();
		} finally {
			ModelRuntime.prototype.setRuntimeApiKey = original;
			t?.dispose();
		}

		// The harness must force the dummy-key refresh offline, same as the
		// initial ModelRuntime.create refresh.
		expect(captured.length).toBeGreaterThan(0);
		expect(captured.at(-1)).toEqual({ allowNetwork: false });
	});

	it("runs a say-only playbook without credentials", async () => {
		const t = await createTestSession();

		await t.run(when("Hello", [says("Hi there!")]));

		expect(t.playbook.consumed).toBe(1);
		expect(t.playbook.remaining).toBe(0);

		t.dispose();
	});

	it("session.agent is typed as AgentSession", async () => {
		const t = await createTestSession();
		// If session is typed as any, this test won't catch it at runtime but
		// the typecheck will — see Cycle 3.
		expect(t.session).toBeDefined();
		expect(typeof t.session.dispose).toBe("function");
		t.dispose();
	});

	it("session.agent has public streamFunction", async () => {
		const t = await createTestSession();
		expect(typeof t.session.agent.streamFunction).toBe("function");
		t.dispose();
	});

	it("session.agent has public state.tools", async () => {
		const t = await createTestSession();
		expect(Array.isArray(t.session.agent.state.tools)).toBe(true);
		t.dispose();
	});

	it("session.agent has waitForIdle", async () => {
		const t = await createTestSession();
		expect(typeof t.session.agent.waitForIdle).toBe("function");
		t.dispose();
	});
});

describe("Pi 0.83 compat — hook pipeline", () => {
	let t: TestSession;

	afterEach(() => t?.dispose());

	it("tool_call hook fires exactly once per mocked tool", async () => {
		const toolCallHooks: Array<{ toolName: string }> = [];

		t = await createTestSession({
			extensionFactories: [
				(pi: any) => {
					pi.on("tool_call", (event: any) => {
						toolCallHooks.push({ toolName: event.toolName });
					});
				},
			],
			mockTools: {
				bash: "ok",
			},
		});

		await t.run(
			when("Call bash once", [calls("bash", { command: "ls" }), says("Done.")]),
		);

		// tool_call must fire exactly one time per mocked call
		expect(toolCallHooks).toHaveLength(1);
		expect(toolCallHooks[0].toolName).toBe("bash");
	});

	it("tool_result hook fires exactly once per mocked tool", async () => {
		const toolResultHooks: Array<{ toolName: string; content: any }> = [];

		t = await createTestSession({
			extensionFactories: [
				(pi: any) => {
					pi.on("tool_result", (event: any) => {
						toolResultHooks.push({
							toolName: event.toolName,
							content: event.content,
						});
					});
				},
			],
			mockTools: {
				bash: "output from mock",
			},
		});

		await t.run(
			when("Call bash", [calls("bash", { command: "ls" }), says("Done.")]),
		);

		expect(toolResultHooks).toHaveLength(1);
		expect(toolResultHooks[0].toolName).toBe("bash");
		expect(toolResultHooks[0].content).toBeDefined();
	});

	it("tool_result hook can modify result content", async () => {
		const capturedToolResults: Array<{ toolName: string; content: any }> = [];

		t = await createTestSession({
			extensionFactories: [
				(pi: any) => {
					pi.on("tool_result", (event: any) => {
						capturedToolResults.push({
							toolName: event.toolName,
							content: event.content,
						});
						// Return modified content
						return {
							content: [
								{
									type: "text",
									text: "MODIFIED: " + (event.content?.[0]?.text ?? ""),
								},
							],
						};
					});
				},
			],
			mockTools: {
				bash: "original output",
			},
		});

		await t.run(
			when("Call bash", [calls("bash", { command: "ls" }), says("Done.")]),
		);

		// Hook saw the original content
		expect(capturedToolResults).toHaveLength(1);
		expect(capturedToolResults[0].content[0].text).toContain("original");

		// The result consumed by the agent loop should be the modified version
		const tr = t.events.toolResultsFor("bash");
		expect(tr).toHaveLength(1);
		expect(tr[0].text).toContain("MODIFIED");
	});

	it("hooks fire exactly once not twice (no double emission)", async () => {
		const hookCounts = { toolCall: 0, toolResult: 0 };

		t = await createTestSession({
			extensionFactories: [
				(pi: any) => {
					pi.on("tool_call", () => {
						hookCounts.toolCall++;
					});
					pi.on("tool_result", () => {
						hookCounts.toolResult++;
					});
				},
			],
			mockTools: {
				bash: "ok",
			},
		});

		await t.run(
			when("Call bash once", [calls("bash", { command: "ls" }), says("Done.")]),
		);

		// AgentSession 0.83 fires hooks internally via beforeToolCall/afterToolCall.
		// The harness must NOT re-emit them.
		expect(hookCounts.toolCall).toBe(1);
		expect(hookCounts.toolResult).toBe(1);
	});
});

describe("Pi 0.83 compat — ExtensionUIContext", () => {
	let t: TestSession;

	afterEach(() => t?.dispose());

	it("setWorkingVisible is callable", async () => {
		const calls: string[] = [];

		t = await createTestSession({
			extensionFactories: [
				(pi: any) => {
					pi.on("agent_start", async (_ev: any, ctx: any) => {
						ctx.ui.setWorkingVisible(false);
						calls.push("setWorkingVisible");
					});
				},
			],
		});

		await t.run(when("Run", [says("Done.")]));
		expect(calls).toContain("setWorkingVisible");
	});

	it("setWorkingIndicator is callable", async () => {
		const calls: string[] = [];

		t = await createTestSession({
			extensionFactories: [
				(pi: any) => {
					pi.on("agent_start", async (_ev: any, ctx: any) => {
						ctx.ui.setWorkingIndicator({ frames: ["●"], intervalMs: 500 });
						calls.push("setWorkingIndicator");
					});
				},
			],
		});

		await t.run(when("Run", [says("Done.")]));
		expect(calls).toContain("setWorkingIndicator");
	});

	it("setHiddenThinkingLabel is callable", async () => {
		const calls: string[] = [];

		t = await createTestSession({
			extensionFactories: [
				(pi: any) => {
					pi.on("agent_start", async (_ev: any, ctx: any) => {
						ctx.ui.setHiddenThinkingLabel("Reasoning...");
						calls.push("setHiddenThinkingLabel");
					});
				},
			],
		});

		await t.run(when("Run", [says("Done.")]));
		expect(calls).toContain("setHiddenThinkingLabel");
	});

	it("addAutocompleteProvider is callable", async () => {
		const calls: string[] = [];

		t = await createTestSession({
			extensionFactories: [
				(pi: any) => {
					pi.on("agent_start", async (_ev: any, ctx: any) => {
						ctx.ui.addAutocompleteProvider((current: any) => current);
						calls.push("addAutocompleteProvider");
					});
				},
			],
		});

		await t.run(when("Run", [says("Done.")]));
		expect(calls).toContain("addAutocompleteProvider");
	});

	it("getEditorComponent returns undefined in mock", async () => {
		// Directly test the mock UI context, not via session
		const { createMockUIContext } = await import("../src/mock-ui.js");
		const ctx = createMockUIContext({}, []);
		expect(ctx.getEditorComponent()).toBeUndefined();
	});

	it("createMockUIContext is typed as ExtensionUIContext (no any cast)", async () => {
		// Import and invoke to verify the return type compiles
		const { createMockUIContext } = await import("../src/mock-ui.js");
		const ctx = createMockUIContext({}, []);
		// All 0.83 ExtensionUIContext members must be present
		expect(typeof ctx.setWorkingVisible).toBe("function");
		expect(typeof ctx.setWorkingIndicator).toBe("function");
		expect(typeof ctx.setHiddenThinkingLabel).toBe("function");
		expect(typeof ctx.addAutocompleteProvider).toBe("function");
		expect(typeof ctx.getEditorComponent).toBe("function");
		expect(ctx.getEditorComponent()).toBeUndefined();
	});
});
