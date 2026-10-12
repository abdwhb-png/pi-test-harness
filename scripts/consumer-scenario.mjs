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
	for (const name of ["createMockPi", "createTestSession", "verifySandboxInstall", "when", "calls", "says", "ToolBlockedError", "safeRmSync"]) {
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
} finally {
	try {
		t?.dispose();
	} finally {
		globalThis.fetch = originalFetch;
	}
}
