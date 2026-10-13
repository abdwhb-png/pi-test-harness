import { describe, expect, it } from "vitest";
import { createCodemodeExtension, createMcpExtension, createToolSearchExtension } from "@earendil-works/pi-coding-agent";
import { McpClient, isJsonRpcRequest } from "@earendil-works/pi-mcp";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpFixture, createTestSession, when, calls, says } from "../src/index.js";

describe("MCP fixture", () => {
	it("isolates options per session and preserves caller-owned state", async () => {
		const fixture = createMcpFixture({ exposure: "direct", tools: [] });
		const first = fixture.extensionOptions;
		const second = fixture.extensionOptions;
		const owned = await createTestSession({ extensionFactories: [createMcpExtension(first)] });
		try {
			await owned.run(when("Empty server", [says("Done.")]));
			expect(first.logPath).toBe(join(owned.cwd, "mcp-fixture.log"));
		} finally { await owned.close(); }
		const cwd = mkdtempSync(join(tmpdir(), "native-caller-"));
		const marker = join(cwd, "keep.txt");
		writeFileSync(marker, "keep");
		let t;
		try {
			t = await createTestSession({ cwd, extensionFactories: [createMcpExtension(second)] });
			await t.run(when("Another empty server", [says("Done.")]));
			await t.close();
			expect(second.logPath).toBe(join(cwd, "mcp-fixture.log"));
			expect(first.logPath).toBe(join(owned.cwd, "mcp-fixture.log"));
			expect(existsSync(marker)).toBe(true);
			expect(fixture.closed).toBe(true);
		} finally { await t?.close(); rmSync(cwd, { recursive: true, force: true }); }
	});

	it("serves a native structured call and closes with its session", async () => {
		const fixture = createMcpFixture({ tools: [{
			tool: { name: "echo", description: "Echo a value", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] }, outputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } },
			response: async args => ({ content: [{ type: "text", text: "echo" }], structuredContent: { value: args.value } }),
		}] });
		const t = await createTestSession({ extensionFactories: [createCodemodeExtension({ models: false }), createMcpExtension(fixture.extensionOptions)] });
		try {
			await t.run(when("Discover and call", [
				calls("codemode", { code: 'text(await searchTools("echo")); const r=await tools.mcp__fixture__echo({value:"saved"}); store("value",r.structuredContent.value); text(r);' }),
				calls("codemode", { code: 'text(load("value"));' }), says("Done."),
			]));
			expect(t.events.toolResultsFor("codemode").every(r => !r.isError)).toBe(true);
			expect(t.events.toolResultsFor("codemode")[1].text).toContain("saved");
			expect(fixture.calls).toMatchObject([{ toolName: "echo", arguments: { value: "saved" } }]);
			expect(t.events.toolResultsFor("mcp__fixture__echo")[0]).toMatchObject({ mocked: false, structuredContent: { structuredContent: { value: "saved" } } });
			expect(fixture.closed).toBe(false);
		} finally { await t.close(); }
		expect(fixture.closed).toBe(true);
	});

	it("rejects unsupported requests and preserves explicit protocol errors", async () => {
		const fixture = createMcpFixture({ tools: [{ tool: { name: "fail", inputSchema: { type: "object" } }, response: { error: { code: -32042, message: "fixture protocol failure" } } }] });
		const transport = fixture.extensionOptions.createTransport!({ name: "fixture", source: "test", config: { command: "unused" } }, process.cwd(), undefined);
		const client = new McpClient({ name: "fixture-test", version: "1.0.0" });
		try {
			await client.connect(transport);
			await expect(client.request("unsupported")).rejects.toMatchObject({ code: -32601 });
			await expect(client.callTool("missing")).rejects.toMatchObject({ code: -32602 });
			await expect(client.callTool("fail")).rejects.toMatchObject({ code: -32042, message: "fixture protocol failure" });
			expect(fixture.calls.map(c => c.toolName)).toEqual(["missing", "fail"]);
		} finally { await client.close(); }
		expect(fixture.closed).toBe(true);
	});

	it("intercepts a nested MCP tool registered after request preparation", async () => {
		const fixture = createMcpFixture({ tools: [{ tool: { name: "echo", inputSchema: { type: "object" } }, response: { content: [{ type: "text", text: "REAL" }] } }] });
		const options = fixture.extensionOptions;
		const createTransport = options.createTransport!;
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		options.createTransport = (...args) => {
			const transport = createTransport(...args);
			const send = transport.send.bind(transport);
			transport.send = async message => {
				if (isJsonRpcRequest(message) && message.method === "tools/list") await gate;
				return send(message);
			};
			return transport;
		};
		let mockCalls = 0;
		const t = await createTestSession({ extensionFactories: [createCodemodeExtension({ models: false }), createMcpExtension(options)],
			mockTools: { mcp__fixture__echo: async () => { mockCalls++; return { content: [{ type: "text", text: "MOCK" }], structuredContent: { content: [{ type: "text", text: "MOCK" }] } }; } },
		});
		const prepare = t.session.agent.prepareRequest;
		let first = true;
		let absent = false;
		t.session.agent.prepareRequest = async (request, signal) => {
			if (first) { first = false; absent = !t.session.getToolDefinition("mcp__fixture__echo"); release(); }
			return (await prepare?.(request, signal)) ?? undefined;
		};
		try {
			await t.run(when("Call late tool", [calls("codemode", { code: 'text((await tools.mcp__fixture__echo({})).content[0].text);' }), says("Done.")]));
			expect(absent).toBe(true);
			expect(mockCalls).toBe(1);
			expect(fixture.calls).toEqual([]);
			expect(t.events.toolResultsFor("codemode")[0]).toMatchObject({ isError: false });
			expect(t.events.toolResultsFor("codemode")[0].text).toContain("MOCK");
			expect(t.events.toolResultsFor("mcp__fixture__echo")[0].mocked).toBe(true);
		} finally { release(); await t.close(); }
	});

	it.each(["direct", "codemode", "deferred", "hidden"] as const)("preserves %s exposure in the prepared transcript", async exposure => {
		const fixture = createMcpFixture({ exposure, tools: [{ tool: { name: "echo", description: "Echo from fixture", inputSchema: { type: "object" } }, response: { content: [{ type: "text", text: "fixture output" }] } }] });
		const t = await createTestSession({ extensionFactories: [createCodemodeExtension({ models: false }), createToolSearchExtension(), createMcpExtension(fixture.extensionOptions)] });
		const declarations: string[][] = [];
		const prepare = t.session.agent.prepareRequest;
		t.session.agent.prepareRequest = async (request, signal) => {
			const update = await prepare?.(request, signal);
			declarations.push(getCurrentTools((update?.context ?? request.context).messages).map(tool => tool.name));
			return update ?? undefined;
		};
		try {
			// Activate discovery explicitly when a hidden server needs no discovery tool.
			if (exposure === "hidden") t.session.setActiveToolsByName([...t.session.getActiveToolNames(), "codemode"]);
			await t.run(when("Expose fixture", exposure === "direct"
				? [calls("mcp__fixture__echo"), says("Done.")]
				: exposure === "deferred"
					? [calls("tool_search", { query: "echo" }), calls("mcp__fixture__echo"), says("Done.")]
					: [calls("codemode", { code: 'text(await searchTools("echo"));' }), calls("codemode", { code: 'text(await tools.mcp__fixture__echo({}));' }), says("Done.")],
			));
			const name = "mcp__fixture__echo";
			if (exposure === "direct") expect(declarations[0]).toContain(name);
			if (exposure === "deferred") {
				expect(declarations[0]).not.toContain(name);
				expect(declarations[1]).toContain(name);
			}
			if (exposure === "codemode" || exposure === "hidden") expect(declarations.every(names => !names.includes(name))).toBe(true);
			expect(t.session.getCallableToolNames().includes(name)).toBe(exposure !== "hidden");
			expect(fixture.calls).toHaveLength(exposure === "hidden" ? 0 : 1);
			if (exposure === "hidden") expect(t.events.toolResultsFor("codemode")[1].isError).toBe(true);
			else expect(t.events.toolResults.at(-1)?.isError).toBe(false);
		} finally { await t.close(); }
	});

	it("preserves per-tool exposure overrides", async () => {
		const fixture = createMcpFixture({ exposure: "hidden", toolExposure: { echo: "direct" }, tools: [{ tool: { name: "echo", inputSchema: { type: "object" } }, response: { content: [] } }] });
		const t = await createTestSession({ extensionFactories: [createMcpExtension(fixture.extensionOptions)] });
		try {
			await t.run(when("Call override", [calls("mcp__fixture__echo"), says("Done.")]));
			expect(fixture.calls).toHaveLength(1);
			expect(t.events.toolResults[0].isError).toBe(false);
		} finally { await t.close(); }
	});

	it("distinguishes protocol, tool, validation and script errors", async () => {
		const fixture = createMcpFixture({ exposure: "direct", tools: [
			{ tool: { name: "protocol_error", inputSchema: { type: "object" } }, response: { error: { code: -32042, message: "protocol failure" } } },
			{ tool: { name: "tool_error", inputSchema: { type: "object" } }, response: { isError: true, content: [{ type: "text", text: "tool failure" }], structuredContent: { failure: true } } },
			{ tool: { name: "required", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }, response: { content: [] } },
		] });
		const t = await createTestSession({ extensionFactories: [createCodemodeExtension({ models: false }), createMcpExtension(fixture.extensionOptions)] });
		t.session.setActiveToolsByName([...t.session.getActiveToolNames(), "codemode"]);
		try {
			await t.run(when("Error paths", [
				calls("mcp__fixture__protocol_error"), calls("mcp__fixture__tool_error"), calls("mcp__fixture__required"),
				calls("codemode", { code: 'const r=await tools.mcp__fixture__tool_error({}); text(r.isError);' }),
				calls("codemode", { code: 'text("partial output"); throw new Error("script failure");' }), says("Done."),
			]));
			expect(t.events.toolResultsFor("mcp__fixture__protocol_error")[0]).toMatchObject({ isError: true, text: expect.stringContaining("protocol failure") });
			expect(t.events.toolResultsFor("mcp__fixture__tool_error")[0]).toMatchObject({ isError: true, structuredContent: { isError: true, structuredContent: { failure: true } } });
			expect(t.events.toolResultsFor("mcp__fixture__required")[0].isError).toBe(true);
			expect(fixture.calls.some(c => c.toolName === "required")).toBe(false);
			expect(t.events.toolResultsFor("codemode")[0]).toMatchObject({ isError: false, text: expect.stringContaining("true") });
			expect(t.events.toolResultsFor("codemode")[1]).toMatchObject({ isError: true, text: expect.stringContaining("partial output") });
			expect(t.events.toolResultsFor("codemode")[1].text).toContain("script failure");
		} finally { await t.close(); }
	});
});
