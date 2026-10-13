import { afterEach, describe, expect, it } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createTestSession, when, calls, says, type TestSession } from "../src/index.js";

describe("native codemode", () => {
	let t: TestSession | undefined;
	afterEach(async () => { await t?.close(); });

	it("replaces nested read execution and restores its definition", async () => {
		let mockCalls = 0;
		t = await createTestSession({
			extensionFactories: [createCodemodeExtension({ models: false })],
			mockTools: { read: () => { mockCalls++; return "MOCK_READ"; } },
		});
		writeFileSync(join(t.cwd, "value.txt"), "REAL_READ");
		t.session.setActiveToolsByName(["codemode", "read"]);
		const definition = t.session.getToolDefinition("read")!;
		const execute = definition.execute;
		await t.run(when("Read through codemode", [
			calls("codemode", { code: 'text(await tools.read({path:"value.txt"}));' }),
			says("Done."),
		]));
		expect(t.events.toolResultsFor("codemode")[0].isError).toBe(false);
		expect(t.events.toolResultsFor("codemode")[0].text).toContain("MOCK_READ");
		expect(t.events.toolResultsFor("codemode")[0].text).not.toContain("REAL_READ");
		expect(mockCalls).toBe(1);
		expect(t.events.toolResultsFor("read")).toMatchObject([{ mocked: true }]);
		expect(definition.execute).toBe(execute);
	});

	it("correlates nested calls and retains structured mock results across runs", async () => {
		t = await createTestSession({
			extensionFactories: [createCodemodeExtension({ models: false })],
			mockTools: { read: async () => ({ content: [{ type: "text", text: "value" }], structuredContent: { value: 42 } }) },
		});
		t.session.setActiveToolsByName(["codemode", "read"]);
		await t.run(when("Nested", [calls("codemode", { code: 'await tools.read({path:"missing.txt"});' }), says("Done.")]));
		const child = t.events.toolResultsFor("read")[0];
		const parent = t.events.toolResultsFor("codemode")[0];
		expect(child).toMatchObject({ parentToolCallId: parent.toolCallId, structuredContent: { value: 42 }, mocked: true });
		expect(t.events.toolCallsFor("read")[0]).toMatchObject({ toolCallId: child.toolCallId, parentToolCallId: parent.toolCallId });
		await t.run(when("Invalid", [calls("read", {}), says("Done.")]));
		expect(t.events.toolResultsFor("read")[1]).toMatchObject({ mocked: false, isError: true });
	});

	it("records refused mocks as unmocked and restores after a failed run", async () => {
		let executions = 0;
		t = await createTestSession({
			extensionFactories: [createCodemodeExtension({ models: false }), (pi: ExtensionAPI) => {
				pi.on("tool_call", event => event.toolName === "read" && event.input.path === "blocked.txt"
					? { block: true, reason: "blocked by test policy" } : undefined);
			}],
			mockTools: { read: () => { executions++; return "mocked"; } },
		});
		t.session.setActiveToolsByName(["codemode", "read"]);
		const definition = t.session.getToolDefinition("read")!;
		const execute = definition.execute;
		await expect(t.run(when("Fail after a call", [
			calls("codemode", { code: 'await tools.read({path:"ok.txt"});' }), says("Stop."), says("Unused."),
		]))).rejects.toThrow("Playbook not fully consumed");
		expect(definition.execute).toBe(execute);
		await t.run(when("Refuse", [calls("codemode", { code: 'await tools.read({path:"blocked.txt"});' }), says("Done.")]));
		expect(executions).toBe(1);
		expect(t.events.toolResultsFor("read")[1]).toMatchObject({ mocked: false, isError: true });
		expect(t.events.blockedCalls()).toMatchObject([{ toolName: "read", blockReason: "blocked by test policy" }]);
	});
});

describe("native shutdown", () => {
	it("awaits shutdown before removing owned state and closes once", async () => {
		let shutdowns = 0;
		let stateExistsDuringShutdown = false;
		const t = await createTestSession({ extensionFactories: [(pi: ExtensionAPI) => {
			pi.on("session_shutdown", async (_event, ctx) => {
				await Promise.resolve();
				stateExistsDuringShutdown = existsSync(ctx.cwd);
				shutdowns++;
			});
		}] });
		try {
			await t.close();
			await t.close();
			expect(shutdowns).toBe(1);
			expect(stateExistsDuringShutdown).toBe(true);
			expect(existsSync(t.cwd)).toBe(false);
			await expect(t.run(when("Closed", [says("Done.")]))).rejects.toThrow(/closed/);
		} finally { t.dispose(); }
	});

	it("rejects overlapping runs and restores interception before shutdown", async () => {
		let started!: () => void;
		const start = new Promise<void>(resolve => { started = resolve; });
		let restored = false;
		let aborted = false;
		let settled = false;
		let laterExecutions = 0;
		const t = await createTestSession({ extensionFactories: [(pi: ExtensionAPI) => {
			pi.registerTool({ name: "wait", label: "Wait", description: "Wait until the session aborts", parameters: Type.Object({}),
				execute: async (_id, _args, signal) => {
					started();
					await new Promise<void>(resolve => { signal!.addEventListener("abort", () => resolve(), { once: true }); });
					aborted = signal!.aborted;
					return { content: [{ type: "text", text: "aborted" }], details: {} };
				},
			});
			pi.registerTool({ name: "later", label: "Later", description: "A later turn", parameters: Type.Object({}),
				execute: async () => { laterExecutions++; return { content: [{ type: "text", text: "later" }], details: {} }; },
			});
			pi.on("session_shutdown", () => { restored = t.session.agent.prepareRequest === prepare; });
		}] });
		const prepare = t.session.agent.prepareRequest;
		const run = t.run(when("Wait", [calls("wait"), says("Done.")]), when("Later", [calls("later"), says("Done.")]));
		const outcome = run.then(() => { settled = true; }, error => { settled = true; return error; });
		try {
			await start;
			await expect(t.run(when("Overlap", [says("No.")]))).rejects.toThrow("already active");
			await t.close();
			expect(restored).toBe(true);
			await outcome;
			expect(settled).toBe(true);
			expect(aborted).toBe(true);
			expect(laterExecutions).toBe(0);
		} finally { await t.close(); }
	});

	it("rejects asynchronous close after legacy disposal", async () => {
		const t = await createTestSession();
		t.dispose();
		await expect(t.close()).rejects.toThrow("disposed before close");
	});
});
