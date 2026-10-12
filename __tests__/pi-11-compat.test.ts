/**
 * Pi 1.1 compatibility tests.
 *
 * These tests verify that the harness works correctly with Pi 1.1 APIs:
 *   - ModelRuntime isolation (no credentials, no ~/.pi touch)
 *   - Public Agent APIs (streamFunction, state.tools, waitForIdle)
 *   - AgentSession hooks (beforeToolCall / afterToolCall installed by AgentSession)
 *   - ExtensionUIContext with indicator and autocomplete members
 *   - AgentSession typed on TestSession.session
 */

import { describe, it, expect, afterEach } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	createTestSession,
	when,
	says,
	calls,
	type TestSession,
} from "../src/index.js";

describe("Pi 1.1 compat — isolated session", () => {
	it("dummy runtime API key synchronization stays offline", async () => {
		// Pi 1.1 owns the offline credential synchronization policy. The
		// harness must not pass the removed allowNetwork option, and session
		// initialization must not attempt a network request.
		type RefreshOptions = Parameters<
			typeof ModelRuntime.prototype.setRuntimeApiKey
		>[2];
		const original = ModelRuntime.prototype.setRuntimeApiKey;
		const captured: RefreshOptions[] = [];
		const originalFetch = globalThis.fetch;
		let fetchCount = 0;
		globalThis.fetch = ((..._args: Parameters<typeof fetch>) => {
			fetchCount += 1;
			throw new Error("unexpected network request");
		}) as typeof fetch;
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
			globalThis.fetch = originalFetch;
			t?.dispose();
		}

		expect(captured.length).toBeGreaterThan(0);
		expect(captured.at(-1)).toBeUndefined();
		expect(fetchCount).toBe(0);
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

describe("Pi 1.1 compat — hook pipeline", () => {
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

		// AgentSession fires hooks internally via beforeToolCall/afterToolCall.
		// The harness must NOT re-emit them.
		expect(hookCounts.toolCall).toBe(1);
		expect(hookCounts.toolResult).toBe(1);
	});
});

describe("Pi 1.1 compat — ExtensionUIContext", () => {
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
		// All supported ExtensionUIContext members must be present
		expect(typeof ctx.setWorkingVisible).toBe("function");
		expect(typeof ctx.setWorkingIndicator).toBe("function");
		expect(typeof ctx.setHiddenThinkingLabel).toBe("function");
		expect(typeof ctx.addAutocompleteProvider).toBe("function");
		expect(typeof ctx.getEditorComponent).toBe("function");
		expect(ctx.getEditorComponent()).toBeUndefined();
	});
});

describe("Pi 1.1 compat — request preparation", () => {
	let t: TestSession;

	afterEach(() => t?.dispose());

	it("preserves prepared tools, thinking level, and abort signal", async () => {
		let originalExecutions = 0;
		let preparedExecutions = 0;
		t = await createTestSession({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "prepared_counter",
						label: "Prepared counter",
						description: "Exercise the prepared request tool registry",
						parameters: Type.Object({}),
						async execute() {
							originalExecutions += 1;
							return { content: [{ type: "text", text: "original" }], details: {} };
						},
					});
				},
			],
			mockTools: { bash: "mocked bash" },
		});
		const agent = t.session.agent;
		const nativePrepareRequest = agent.prepareRequest;
		const requests: Array<{
			signal: AbortSignal | undefined;
			activeSignal: AbortSignal | undefined;
			modelId: string;
		}> = [];
		const prepareRequest: NonNullable<typeof agent.prepareRequest> = async (
			request,
			signal,
		) => {
			requests.push({
				signal,
				activeSignal: agent.signal,
				modelId: request.model.id,
			});
			const update = await nativePrepareRequest?.(request, signal);
			const context = update?.context ?? request.context;
			return {
				...update,
				thinkingLevel: "high",
				context: {
					...context,
					tools: context.tools?.map((tool) =>
						tool.name === "prepared_counter"
							? {
								...tool,
								async execute() {
									preparedExecutions += 1;
									return {
										content: [{ type: "text", text: "prepared execution" }],
										details: {},
									};
								},
							}
							: tool,
					),
				},
			};
		};
		agent.prepareRequest = prepareRequest;

		await t.run(
			when("Run prepared tools", [
				calls("prepared_counter", {}),
				calls("bash", { command: "must be mocked" }),
				says("Done."),
			]),
		);

		expect(originalExecutions).toBe(0);
		expect(preparedExecutions).toBe(1);
		expect(t.events.toolResultsFor("prepared_counter")).toMatchObject([
			{ text: "prepared execution", mocked: false, isError: false },
		]);
		expect(t.events.toolResultsFor("bash")).toMatchObject([
			{ text: "mocked bash", mocked: true, isError: false },
		]);
		expect(requests).toHaveLength(3);
		expect(requests[0].modelId).toBe("gpt-4o");
		expect(t.events.messages
			.filter((message) => message.role === "assistant")
			.map((message) => message.thinkingLevel)
		).toEqual(["high", "high", "high"]);
		for (const request of requests) {
			expect(request.signal).toBeInstanceOf(AbortSignal);
			expect(request.signal).toBe(request.activeSignal);
		}
		expect(agent.prepareRequest).toBe(prepareRequest);
	});

	it.each(["success", "failure"])("restores the callback after %s and allows another run", async (outcome) => {
		t = await createTestSession({ mockTools: { bash: "recovered" } });
		const originalPrepareRequest = t.session.agent.prepareRequest;
		const run = t.run(when("First run", outcome === "failure"
			? [says("Stopped."), says("Unused.")]
			: [says("Done.")],
		));
		if (outcome === "failure") {
			await expect(run).rejects.toThrow("Playbook not fully consumed");
		} else {
			await run;
		}
		expect(t.session.agent.prepareRequest).toBe(originalPrepareRequest);

		await t.run(when("Run again", [calls("bash", { command: "must be mocked" }), says("Done.")]));
		expect(t.events.toolResultsFor("bash")).toMatchObject([{ text: "recovered", mocked: true, isError: false }]);
		expect(t.session.agent.prepareRequest).toBe(originalPrepareRequest);
	});

	it.each(["success", "failure"])("restores an absent callback after %s", async (outcome) => {
		t = await createTestSession();
		t.session.agent.prepareRequest = undefined;
		const run = t.run(when("Run without preparation", outcome === "failure"
			? [says("Stopped."), says("Unused.")]
			: [says("Done.")],
		));
		if (outcome === "failure") {
			await expect(run).rejects.toThrow("Playbook not fully consumed");
		} else {
			await run;
		}
		expect(t.session.agent.prepareRequest).toBeUndefined();
	});
});
