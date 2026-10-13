import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Copied into each isolated consumer so imports resolve to its installed
// artifact, never to the checkout or its development dependencies.
const [packageName, runtime, version, peerRangesJson, peerVersionsJson] = process.argv.slice(2);
assert.equal(Boolean(process.versions.bun), runtime === "bun", "Unexpected child runtime");
console.log(`runtime: ${runtime} ${process.versions.bun ?? process.versions.node}`);

const packageDir = join(process.cwd(), "node_modules", packageName);
const installed = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
assert.equal(installed.name, packageName);
assert.equal(installed.version, version);
assert.deepEqual(installed.peerDependencies, JSON.parse(peerRangesJson));
assert.ok(existsSync(join(packageDir, installed.exports["."].types)), "Packed declarations missing");
const skill = readFileSync(join(packageDir, "skills", "pi-test-harness", "SKILL.md"), "utf8");
assert.ok(skill.includes(`version: "${version}"`), "Bundled skill version differs from the package");
assert.ok(existsSync(join(packageDir, "skills", "pi-test-harness", "references", "api-reference.md")), "Bundled skill references missing");
for (const [name, pinned] of Object.entries(JSON.parse(peerVersionsJson))) {
	const peer = JSON.parse(readFileSync(join(process.cwd(), "node_modules", name, "package.json"), "utf8"));
	assert.equal(peer.version, pinned, `Unexpected installed version of ${name}`);
	console.log(`peer: ${name}@${peer.version}`);
}

let networkRequests = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = () => {
	networkRequests += 1;
	throw new Error("Unexpected network request during consumer session");
};
let t;
try {
	const harness = await import(packageName);
	for (const name of ["createMockPi", "createTestSession", "createMcpFixture", "verifySandboxInstall", "when", "calls", "says", "ToolBlockedError", "safeRmSync"]) {
		assert.equal(typeof harness[name], "function", `Missing public export: ${name}`);
	}
	const { createTestSession, when, calls, says } = harness;
	let realExecutions = 0;
	let mockedExecutions = 0;
	const callHooks = [];
	const resultHooks = [];
	t = await createTestSession({
		extensionFactories: [(pi) => {
			pi.registerTool({
				name: "consumer_counter",
				label: "Consumer counter",
				description: "A real tool in an isolated consumer fixture",
				parameters: { type: "object", properties: {} },
				async execute() {
					realExecutions += 1;
					return { content: [{ type: "text", text: String(realExecutions) }], details: {} };
				},
			});
			pi.on("tool_call", (event) => {
				callHooks.push(event.toolName);
				if (event.toolName === "bash" && event.input.command === "blocked") {
					return { block: true, reason: "blocked by consumer fixture" };
				}
			});
			pi.on("tool_result", (event) => {
				resultHooks.push(event.toolName);
				return { content: [{ type: "text", text: `hook:${event.content[0].text}` }] };
			});
		}],
		mockTools: { bash: () => {
			mockedExecutions += 1;
			return "mock output";
		} },
	});
	const originalPrepareRequest = t.session.agent.prepareRequest;
	await t.run(when("Run real and mocked tools", [
		calls("consumer_counter", {}),
		calls("bash", { command: "echo should-not-execute" }),
		says("Done."),
	]));
	assert.deepEqual(t.playbook, { consumed: 3, remaining: 0 });
	assert.equal(realExecutions, 1);
	assert.equal(mockedExecutions, 1);
	assert.deepEqual(callHooks, ["consumer_counter", "bash"]);
	assert.deepEqual(resultHooks, ["consumer_counter", "bash"]);
	assert.equal(t.events.toolResultsFor("consumer_counter").length, 1);
	assert.equal(t.events.toolResultsFor("consumer_counter")[0].text, "hook:1");
	assert.equal(t.events.toolResultsFor("consumer_counter")[0].mocked, false);
	assert.equal(t.events.toolResultsFor("bash").length, 1);
	assert.equal(t.events.toolResultsFor("bash")[0].text, "hook:mock output");
	assert.equal(t.events.toolResultsFor("bash")[0].mocked, true);
	assert.equal(t.events.toolResultsFor("bash")[0].isError, false);
	assert.equal(t.session.agent.prepareRequest, originalPrepareRequest);

	await t.run(when("Refuse a mocked tool", [calls("bash", { command: "blocked" }), says("Refused.")]));
	assert.equal(mockedExecutions, 1, "The blocked mock must not execute");
	assert.equal(t.events.blockedCalls().length, 1);
	assert.match(t.events.blockedCalls()[0].blockReason, /blocked by consumer fixture/);
	assert.equal(t.events.toolResultsFor("bash")[1].isError, true);
	assert.match(t.events.toolResultsFor("bash")[1].text, /blocked by consumer fixture/);

	await t.run(when("Run a real tool again", [calls("consumer_counter", {}), says("Done.")]));
	assert.equal(realExecutions, 2);
	assert.equal(t.events.toolResultsFor("consumer_counter").length, 2);
	assert.equal(t.events.toolResultsFor("consumer_counter")[1].text, "hook:2");
	assert.equal(callHooks.filter((name) => name === "consumer_counter").length, 2);
	assert.equal(resultHooks.filter((name) => name === "consumer_counter").length, 2);
	assert.equal(t.session.agent.prepareRequest, originalPrepareRequest);

	await assert.rejects(t.run(when("Stop early", [says("Stopped."), says("Unused.")])), /Playbook not fully consumed/);
	assert.equal(t.session.agent.prepareRequest, originalPrepareRequest);
	await t.run(when("Recover", [calls("bash", { command: "echo should-not-execute" }), says("Recovered.")]));
	assert.equal(mockedExecutions, 2);
	assert.equal(t.events.toolResultsFor("bash").length, 3);
	assert.equal(t.events.toolResultsFor("bash")[2].text, "hook:mock output");
	assert.equal(t.events.toolResultsFor("bash")[2].isError, false);
	assert.equal(t.session.agent.prepareRequest, originalPrepareRequest);
	assert.deepEqual(t.playbook, { consumed: 2, remaining: 0 });
	assert.equal(networkRequests, 0);
	console.log("session: tools, hooks, policy refusal, callback restoration, and recovery OK");
	await t.close();
	t = undefined;

	// Installed-artifact qualification also exercises the real codemode worker.
	const { createCodemodeExtension, createMcpExtension, createToolSearchExtension } = await import("@earendil-works/pi-coding-agent");
	const { getCurrentTools } = await import("@earendil-works/pi-ai");
	for (const exposure of ["direct", "codemode", "deferred", "hidden"]) {
		const fixture = harness.createMcpFixture({ exposure, tools: [{
			tool: { name: "echo", description: "Native fixture echo", inputSchema: { type: "object" } },
			response: { content: [{ type: "text", text: "native response" }], structuredContent: { value: "stored" } },
		}] });
		let nestedMocks = 0;
		t = await createTestSession({
			extensionFactories: [createCodemodeExtension({ models: false }), createToolSearchExtension(), createMcpExtension(fixture.extensionOptions)],
			mockTools: { read: async () => { nestedMocks++; return "nested mock"; } },
		});
		const declarations = [];
		const nativePrepare = t.session.agent.prepareRequest;
		t.session.agent.prepareRequest = async (request, signal) => {
			const update = await nativePrepare?.(request, signal);
			declarations.push(getCurrentTools((update?.context ?? request.context).messages).map(tool => tool.name));
			return update;
		};
		const name = "mcp__fixture__echo";
		try {
			if (exposure === "hidden") t.session.setActiveToolsByName([...t.session.getActiveToolNames(), "codemode"]);
			const actions = exposure === "direct" ? [calls(name)]
				: exposure === "deferred" ? [calls("tool_search", { query: "echo" }), calls(name)]
					: [calls("codemode", { code: 'text(await searchTools("echo"));' }), calls("codemode", { code: 'const r=await tools.mcp__fixture__echo({}); text(r); store("value",r.structuredContent.value);' })];
			await t.run(when("Native exposure", [...actions, says("Done.")]));
			assert.equal(t.session.getCallableToolNames().includes(name), exposure !== "hidden");
			assert.equal(fixture.calls.length, exposure === "hidden" ? 0 : 1);
			if (exposure === "direct") assert.ok(declarations[0].includes(name));
			if (exposure === "deferred") {
				assert.ok(!declarations[0].includes(name));
				assert.ok(declarations[1].includes(name));
			}
			if (exposure === "codemode" || exposure === "hidden") assert.ok(declarations.every(names => !names.includes(name)));
			if (exposure === "hidden") assert.equal(t.events.toolResultsFor("codemode")[1].isError, true);
			else assert.equal(t.events.toolResultsFor(name)[0].isError, false);
			if (exposure === "codemode") {
				await t.run(when("Read stored result and mock", [calls("codemode", { code: 'text(load("value")); text(await tools.read({path:"missing.txt"}));' }), says("Done.")]));
				assert.equal(nestedMocks, 1);
				const result = t.events.toolResultsFor("codemode").at(-1);
				assert.equal(result.isError, false);
				assert.match(result.text, /stored/);
				assert.match(result.text, /nested mock/);
				assert.equal(t.events.toolResultsFor("read")[0].parentToolCallId, result.toolCallId);
				assert.equal(t.events.toolResultsFor("read")[0].mocked, true);
				assert.deepEqual(t.events.toolResultsFor(name)[0].structuredContent.structuredContent, { value: "stored" });
			}
		} finally { await t.close(); t = undefined; }
		assert.equal(fixture.closed, true);
	}
	assert.equal(networkRequests, 0);
	console.log("native: MCP exposure, codemode, nested mocks, structured results, store/load, shutdown OK");
} finally {
	try {
		await t?.close();
	} finally {
		globalThis.fetch = originalFetch;
	}
}
