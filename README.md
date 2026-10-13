# @abdwhb-png/pi-test-harness

Test harness for [pi](https://github.com/earendil-works/pi-coding-agent) extensions — in-process session testing with playbook-driven model mocking, package install verification, and subprocess mocking.

**Pi 1.1.x only.** This checkout adds native MCP/codemode capabilities for the next minor release. It uses the five Pi peers listed below, qualified against exact Pi 1.1.0. The published 0.9.0 release predates these additions.

## Why

Testing pi extensions is hard. Extensions register tools, subscribe to hooks, intercept tool calls, use UI — all deeply integrated with pi's runtime. Mocking everything produces tests that don't reflect reality. Not testing produces extensions that break in production.

pi-test-harness takes a different approach: **let pi be pi.** Everything runs for real — extension loading, tool registration, hooks, event lifecycle, session state. Only the model is replaced (via `streamFunction`), and optionally tool execution is intercepted for tools you don't want to run for real.

The result: tests that exercise real code paths, in ~10 lines of setup, with zero LLM calls.

## Install

```bash
npm install --save-dev @abdwhb-png/pi-test-harness
```

### Bundled skill

The repository and published package include the canonical `pi-test-harness` skill at `skills/pi-test-harness/`. Install that directory with your skill manager, or load the package as a Pi package, to make the skill available to agents. Installing the harness only as an npm/Bun development dependency does not activate the skill automatically.

### Peer dependencies

- `@earendil-works/pi-coding-agent` ~1.1.0
- `@earendil-works/pi-ai` ~1.1.0
- `@earendil-works/pi-agent-core` ~1.1.0
- `@earendil-works/pi-codemode` ~1.1.0
- `@earendil-works/pi-mcp` ~1.1.0

The codemode peer prevents fresh installs of Pi 1.1 from selecting codemode 1.2 through Pi's broader transitive range. That combination removes exports Pi 1.1 imports and fails before a session starts. Keep native packages on the declared 1.1 line.

### Supported Pi line

The harness version and the Pi version are independent tracks — do not compare them numerically. Which Pi line a harness release supports is declared in `peerDependencies` above; the table records it per release.

| Harness | Supported Pi | Notes                                                    |
| ------- | ------------ | -------------------------------------------------------- |
| 0.9.x   | 1.1.x        | Request-time interception and Node/Bun artifact qualification |
| 0.8.x   | 0.85.x       | Loader parity for top-level-await entrypoints            |
| 0.7.x   | 0.84.x       | Pi 0.84 support                                          |

### Ways to install it

1. **From npm (after publication):** `sfw npm install --save-dev @abdwhb-png/pi-test-harness@0.9.0`. This is the packed artifact a consumer receives.
2. **Pre-release:** changes that need testing before a final version are published under the `next` dist-tag, so `npm install --save-dev @abdwhb-png/pi-test-harness@next` picks one up without inventing a `0.x` release.
3. **Local checkout (harness development):** `bun link` in the harness repo, then `bun link @abdwhb-png/pi-test-harness` in the consumer, or point the dependency at a `file:` path. Consumers read `dist/`, so run `npm run build` after editing `src/`, and never commit a lockfile that resolves to the link.

## Quick Start

```typescript
import { describe, it, expect, afterEach } from "vitest";
import {
  createTestSession,
  when, calls, says,
  type TestSession,
} from "@abdwhb-png/pi-test-harness";

describe("my extension", () => {
  let t: TestSession;
  afterEach(() => t?.dispose());

  it("calls a tool and responds", async () => {
    t = await createTestSession({
      extensions: ["./src/index.ts"],
      mockTools: {
        bash: (params) => `$ ${params.command}\nfile1.txt\nfile2.txt`,
        read: "file contents here",
        write: "written",
        edit: "edited",
      },
    });

    await t.run(
      when("List files in the project", [
        calls("bash", { command: "ls" }),
        says("Found 2 files: file1.txt and file2.txt"),
      ]),
    );

    expect(t.events.toolResultsFor("bash")).toHaveLength(1);
    expect(t.events.toolResultsFor("bash")[0].text).toContain("file1.txt");
    expect(t.events.toolResultsFor("bash")[0].mocked).toBe(true);
  });
});
```

## Architecture

```
┌───────────────────────────────────────────┐
│  Real pi environment                      │
│                                           │
│  ModelRuntime (isolated, no ~/.pi touch)  │
│  Extensions ─── loaded for real           │
│  Tool registry ─ real hooks + wrapping    │
│  Session state ─ in-memory persistence    │
│                                           │
│  ┌─────────────────────────────────────┐  │
│  │         Agent Loop                  │  │
│  │                                     │  │
│  │  streamFunction ── REPLACED by play │  │
│  │  tool.execute()  INTERCEPTED if mock│  │
│  │  ctx.ui.*        INTERCEPTED + log  │  │
│  │  tool_call/result AGENTSESSION hook │  │
│  └─────────────────────────────────────┘  │
└───────────────────────────────────────────┘
```

Three substitution points at the boundary — everything else runs through pi's real code:

| What | Substituted with | Purpose |
| ------ | ----------------- | --------- |
| `streamFunction` | Playbook | Scripts what the model "decides" |
| `tool.execute()` | Mock handler | Controls what tools "return" |
| `ctx.ui.*` | Mock UI | Controls what the user "answers" |

**Request and hook pipeline.** Pi 1.1 rebuilds its executable tool registry while preparing each model request. During `run()`, the harness composes with `Agent.prepareRequest`, wraps the tools from the prepared context, and preserves the callback's other updates. The previous callback is restored in `finally`, including after a failed run. AgentSession owns `beforeToolCall`/`afterToolCall`, which drive extension `tool_call`/`tool_result` events exactly once. The harness does not re-emit them. The session subscriber records the finalized `tool_execution_end` result, including hook modifications.

**ModelRuntime isolation.** The session creates an isolated `ModelRuntime` with `authPath` under the working directory and `modelsPath: null`. No credentials file is read from `~/.pi/agent`. A dummy API key is injected to satisfy AgentSession auth checks (the model is never called).

## Playbook DSL

The playbook replaces the LLM. Instead of calling a model, the agent loop consumes scripted actions in order.

### `when(prompt, actions)`

Defines a conversation turn — the prompt you'll send and what the model does in response:

```typescript
when("Deploy the app", [
  calls("bash", { command: "npm run build" }),
  calls("bash", { command: "gcloud run deploy" }),
  says("Deployed successfully."),
])
```

### `calls(tool, params)`

The model calls a tool. Pi's hooks fire, the tool executes (real or mocked), result feeds back:

```typescript
calls("plan_mode", { enable: true })
calls("bash", { command: "ls -la" })
```

### `says(text)`

The model emits text. The agent turn ends:

```typescript
says("All done. The deployment is complete.")
```

### Multi-turn conversations

Pass multiple turns to `run()`:

```typescript
await t.run(
  when("What files are in the project?", [
    calls("bash", { command: "ls" }),
    says("Found 3 files."),
  ]),
  when("Now read the README", [
    calls("read", { path: "README.md" }),
    says("Here's what it says..."),
  ]),
);
```

## Mock Tools

`mockTools` intercepts `tool.execute()` for specific tools. Pi's tool registry and event flow remain untouched. Extension hooks (`tool_call`, `tool_result`) fire through AgentSession's `beforeToolCall`/`afterToolCall` — the harness does not re-emit them.

```typescript
const t = await createTestSession({
  extensions: ["./src/index.ts"],
  mockTools: {
    // Static string → becomes { content: [{ type: "text", text: "..." }] }
    bash: "command output here",

    // Dynamic function → receives params, returns string or ToolResult
    read: (params) => `contents of ${params.path}`,

    // Full ToolResult for precise control
    write: {
      content: [{ type: "text", text: "Written successfully" }],
      details: { bytesWritten: 42 },
    },
  },
});
```

**Extension-registered tools execute for real** unless they appear in `mockTools`. This lets you test your extension's actual tool logic while controlling the built-in tools.

## Late-bound Params & `.then()`

When one tool call produces a value needed by the next, use `.then()` to capture it and `() => params` for late binding:

```typescript
let planId = "";

await t.run(
  when("Create and approve a plan", [
    calls("plan_propose", {
      title: "Send invoice",
      steps: [{ description: "Send email", tool: "go-easy", operation: "send" }],
    }).then((result) => {
      // Extract the plan ID from the tool result
      planId = result.text.match(/PLAN-[a-f0-9]+/)![0];
    }),
    // Late-bound: params resolved at call time, after .then() has fired
    calls("plan_approve", () => ({ id: planId })),
    says("Plan approved and executing."),
  ]),
);

expect(planId).toMatch(/^PLAN-/);
```

## Mock UI

Extensions that call `ctx.ui.confirm()`, `ctx.ui.select()`, etc. get mock responses. All calls are recorded for assertions.

```typescript
const t = await createTestSession({
  extensions: ["./src/index.ts"],
  mockUI: {
    confirm: false,                    // deny all confirmations
    select: 0,                         // always pick first item
    input: "user input text",          // return fixed string
    editor: "edited content",          // return fixed string
  },
});

// ... run playbook ...

// Assert the extension asked for confirmation
expect(t.events.uiCallsFor("confirm")).toHaveLength(1);
expect(t.events.uiCallsFor("confirm")[0].returnValue).toBe(false);
```

Dynamic handlers are also supported:

```typescript
mockUI: {
  confirm: (title, message) => title.includes("Delete") ? false : true,
  select: (title, items) => items.find(i => i.includes("staging")),
}
```

**Defaults** (when no mock config is provided): `confirm → true`, `select → first item`, `input → ""`, `editor → ""`.

The mock UI context implements the Pi 1.1 `ExtensionUIContext` interface, including `setWorkingVisible`, `setWorkingIndicator`, `setHiddenThinkingLabel`, `addAutocompleteProvider`, and `getEditorComponent` (returns `undefined`). All calls are logged in `t.events.ui`.

## Event Collection

Every session event, tool call, tool result, message, and UI interaction is collected:

```typescript
// Tool events
t.events.toolCallsFor("bash")        // ToolCallRecord[] for "bash"
t.events.toolResultsFor("bash")      // ToolResultRecord[] for "bash"
t.events.blockedCalls()              // tools blocked by hooks (e.g., plan mode)

// UI events
t.events.uiCallsFor("notify")       // UICallRecord[] for notify()
t.events.uiCallsFor("confirm")      // UICallRecord[] for confirm()

// Messages and raw events
t.events.messages                    // AgentMessage[]
t.events.all                        // AgentSessionEvent[] (everything)
```

### ToolResultRecord

```typescript
interface ToolResultRecord {
  step: number;                // playbook step index
  toolName: string;
  toolCallId: string;
  text: string;                // concatenated text content
  content: Array<{ type: string; text?: string }>;
  isError: boolean;
  mocked: boolean;             // true if mockTools handled it
}
```

## Error Propagation

By default (`propagateErrors: true`), real tool errors abort the test with a diagnostic pointing to the exact playbook step:

```
Error during tool execution at playbook step 3 (call "bash"):
  ENOENT: no such file or directory '/foo/bar'
  at Object.readFileSync (node:fs:...)

This error was thrown by the real tool execution, not by the playbook.
To capture errors as tool results instead of aborting, set:
  createTestSession({ propagateErrors: false })
```

Set `propagateErrors: false` to capture errors as `isError: true` in the result instead:

```typescript
const t = await createTestSession({
  propagateErrors: false,
  // ...
});
```

## Playbook Diagnostics

The harness auto-asserts that all playbook actions are consumed after `run()` completes. If the playbook is exhausted early or has remaining unconsumed actions, you get a clear diagnostic:

```
Playbook exhausted unexpectedly.
  Consumed 2 action(s).
  Last consumed: calls("bash", {"command":"ls"}) at step 2

  The agent loop called streamFn but no more playbook actions were available.
  This usually means a tool call produced an unexpected result that caused
  additional streamFn calls (retries, error handling).
```

```
Playbook not fully consumed after run() completed.
  Consumed 1 of 3 action(s).
  Remaining:
    - calls("write", {"path":"out.txt","content":"hello"})
    - says("Done writing.")

  The agent loop ended before all playbook actions were used.
  This usually means a tool was blocked by a hook or returned early,
  causing fewer streamFn calls than expected.
```

## Sandbox Install Verification

Catches broken packages before publish — verifies that `npm pack` → install → load actually works:

```typescript
import { verifySandboxInstall } from "@abdwhb-png/pi-test-harness";

const result = await verifySandboxInstall({
  packageDir: "./packages/my-extension",
  expect: {
    extensions: 1,
    tools: ["my_tool", "my_other_tool"],
    skills: 0,
  },
});

expect(result.loaded.extensionErrors).toEqual([]);
expect(result.loaded.tools).toContain("my_tool");
```

Optionally run a smoke test inside the sandbox:

```typescript
const result = await verifySandboxInstall({
  packageDir: "./packages/my-extension",
  expect: { extensions: 1 },
  smoke: {
    mockTools: { bash: "ok", read: "contents", write: "written", edit: "edited" },
    script: [
      when("Test", [
        calls("my_tool", { value: "test" }),
        says("Works."),
      ]),
    ],
  },
});
```

### Custom npm command (`npmCommand`)

Use a non-default npm executable for pack/install:

```typescript
const result = await verifySandboxInstall({
  packageDir: "./packages/my-extension",
  npmCommand: ["sfw", "npm"], // route through Socket Firewall
  expect: { extensions: 1 },
});
```

Default: `["npm"]` (or `["npm.cmd"]` on Windows). Pass any `execFileSync`-compatible argv.

## Mock Pi CLI

For extensions that spawn `pi --mode json -p` as a subprocess (e.g., subagent orchestrators), `createMockPi()` puts a fake `pi` binary in PATH that returns controllable responses.

```typescript
import { createMockPi } from "@abdwhb-png/pi-test-harness";

const mockPi = createMockPi();
mockPi.install();  // creates temp dir with pi shim, prepends PATH

// Queue responses (consumed in order, last one repeats)
mockPi.onCall({ output: "Hello from agent", exitCode: 0 });
mockPi.onCall({ stderr: "agent crashed", exitCode: 1 });
mockPi.onCall({
  jsonl: [
    { type: "tool_execution_start", toolName: "bash" },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
  ],
});

// Write files during execution (e.g., chain_dir output simulation)
mockPi.onCall({
  output: "Result written",
  writeFiles: { "/tmp/output.md": "# Result\nDone." },
});

// Reset queue between tests
mockPi.reset();

// Check invocation count
expect(mockPi.callCount()).toBe(0);

// Cleanup
mockPi.uninstall();  // restores PATH, deletes temp dir
```

### How it works

1. `install()` creates a temp directory with a platform-specific shim (`pi.cmd` on Windows, `pi` shell script on Linux)
2. The shim is prepended to PATH so `child_process.spawn("pi", ...)` resolves to it
3. Each invocation reads the next response from a file-based queue (`queue.json` + `counter`)
4. When the queue is exhausted, the last response repeats
5. If no responses are queued, the mock echoes the task text

### Response options

| Field | Type | Default | Description |
| ------- | ------ | --------- | ------------- |
| `output` | `string` | echo task | Text in the `message_end` event |
| `exitCode` | `number` | `0` | Process exit code |
| `stderr` | `string` | — | Written to stderr |
| `delay` | `number` | `0` | Delay in ms before responding |
| `jsonl` | `object[]` | — | Raw JSONL events (replaces default `message_end`) |
| `writeFiles` | `Record<string, string>` | — | Files to create (path → content) |

### Safety features

- **Exit handler**: PATH is restored on process exit even if `uninstall()` isn't called (test crash safety)
- **Key validation**: Typos like `{ ouptut: "..." }` throw immediately instead of silently passing
- **Timeout**: Mock script exits after 30s to prevent hanging tests

### Concurrency

Designed for **serial subprocess spawns** within a single test. If your test spawns multiple pi processes concurrently, responses may be consumed out of order.

### Test layer summary

| Layer | What it mocks | Use when |
| ------- | -------------- | ---------- |
| `createTestSession` | LLM (`streamFunction`) | Testing extension logic in-process |
| `verifySandboxInstall` | Nothing (real install) | Verifying npm package works |
| `createMockPi` | pi CLI binary | Testing subprocess-spawning extensions |

## API Reference

### `createTestSession(options?)`

Creates a test session with a real pi environment.

| Option | Type | Default | Description |
| -------- | ------ | --------- | ------------- |
| `extensions` | `string[]` | `[]` | Extension file paths to load |
| `extensionFactories` | `Function[]` | `[]` | Inline extension factory functions |
| `cwd` | `string` | auto temp dir | Working directory (cleaned on dispose if auto) |
| `systemPrompt` | `string` | — | Override the system prompt |
| `mockTools` | `Record<string, MockToolHandler>` | — | Tool execution interceptors |
| `mockUI` | `MockUIConfig` | defaults | UI mock configuration |
| `propagateErrors` | `boolean` | `true` | Abort test on real tool throw |

Returns `Promise<TestSession>`.

### `TestSession`

| Property / Method | Type | Description |
| ------------------- | ------ | ------------- |
| `run(...turns)` | `Promise<void>` | Run the conversation script |
| `session` | `AgentSession` | The real pi session underneath (typed) |
| `cwd` | `string` | Working directory |
| `events` | `TestEvents` | All collected events |
| `playbook` | `{ consumed, remaining }` | Playbook consumption state |
| `close()` | `Promise<void>` | Await native shutdown, then remove owned temporary state |
| `dispose()` | `void` | Legacy synchronous cleanup without shutdown hooks |

### `verifySandboxInstall(options)`

| Option | Type | Description |
| -------- | ------ | ------------- |
| `packageDir` | `string` | Package directory (must have `package.json`) |
| `npmCommand` | `string[]` | Custom npm command argv (default: platform npm) |
| `expect.extensions` | `number` | Expected extension count |
| `expect.tools` | `string[]` | Expected tool names |
| `expect.skills` | `number` | Expected skill count |
| `smoke.mockTools` | `Record<string, MockToolHandler>` | Mock tools for smoke test |
| `smoke.script` | `Turn[]` | Playbook script for smoke test |

### `createMockPi()`

Creates a mock pi CLI with file-based response queue.

Returns `MockPi`:

| Property / Method | Type | Description |
| ------------------- | ------ | ------------- |
| `install()` | `void` | Create shim, prepend to PATH |
| `uninstall()` | `void` | Restore PATH, delete temp dir |
| `onCall(response)` | `void` | Queue a `MockPiCall` response |
| `reset()` | `void` | Clear queue and counter |
| `callCount()` | `number` | Number of times mock pi was invoked |
| `dir` | `string` | Temp directory path |

### `MockToolHandler`

```typescript
type MockToolHandler =
  | string                                             // static text
  | ToolResult                                         // full result object
  | ((params: Record<string, unknown>) => string | ToolResult);  // dynamic
```

### `MockUIConfig`

```typescript
interface MockUIConfig {
  confirm?: boolean | ((title: string, message: string) => boolean);
  select?: number | string | ((title: string, items: string[]) => string | undefined);
  input?: string | ((title: string, placeholder?: string) => string | undefined);
  editor?: string | ((title: string, prefilled?: string) => string | undefined);
}
```

### `ToolBlockedError`

Kept for backward compatibility. In Pi 1.1, tool blocking is handled by AgentSession's `beforeToolCall` before `execute()` is reached, so `ToolBlockedError` is not thrown by the normal mock flow. It remains exported for instanceof checks on errors from event callbacks:

```typescript
import { ToolBlockedError } from "@abdwhb-png/pi-test-harness";

const err = new ToolBlockedError("tool was blocked");
expect(err instanceof ToolBlockedError).toBe(true);
```

### `safeRmSync(filePath)`

Removes a file, swallowing `EPERM`/`EBUSY` errors only. Intended for `afterEach` cleanup of extension-owned SQLite files on Windows. See [Platform Notes](#platform-notes).

## Real-World Example: Testing pi-planner

Testing an extension that registers 8 tools, blocks writes in plan mode, and manages plan lifecycle:

```typescript
import { createTestSession, when, calls, says, type TestSession } from "@abdwhb-png/pi-test-harness";
import * as path from "node:path";

const EXTENSION = path.resolve(__dirname, "../../src/index.ts");
const MOCKS = {
  bash: (p: Record<string, unknown>) => `mock: ${p.command}`,
  read: "mock contents", write: "mock written", edit: "mock edited",
};

describe("pi-planner", () => {
  let t: TestSession;
  afterEach(() => t?.dispose());

  it("enters plan mode and proposes a plan", async () => {
    t = await createTestSession({
      extensions: [EXTENSION],
      mockTools: MOCKS,
    });

    let planId = "";

    await t.run(
      when("Plan the deployment", [
        calls("plan_mode", { enable: true }),
        calls("plan_propose", {
          title: "Deploy v2",
          steps: [
            { description: "Build", tool: "bash", operation: "build" },
            { description: "Deploy", tool: "gcloud", operation: "deploy" },
          ],
        }).then((r) => {
          planId = r.text.match(/PLAN-[a-f0-9]+/)![0];
        }),
        says("Plan proposed."),
      ]),
    );

    expect(planId).toMatch(/^PLAN-/);
    expect(t.events.toolResultsFor("plan_mode")[0].text).toContain("enabled");
    expect(t.events.uiCallsFor("notify")).toHaveLength(1);
  });
});
```

## Native MCP/codemode

Compose native Pi factories explicitly. The harness controls the external MCP peer and records Pi's execution events. Pi owns discovery, exposure, schema validation and the codemode engine.

```typescript
import { createCodemodeExtension, createMcpExtension } from "@earendil-works/pi-coding-agent";
import { createMcpFixture, createTestSession, when, calls, says } from "@abdwhb-png/pi-test-harness";

const fixture = createMcpFixture({
  name: "demo",
  exposure: "codemode",
  tools: [{
    tool: {
      name: "echo",
      description: "Echo a value",
      inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
      outputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    },
    response: async args => ({
      content: [{ type: "text", text: String(args.value) }],
      structuredContent: { value: args.value },
    }),
  }],
});
const t = await createTestSession({
  extensionFactories: [createCodemodeExtension({ models: false }), createMcpExtension(fixture.extensionOptions)],
});
try {
  await t.run(when("Discover and call", [
    calls("codemode", { code: 'text(await searchTools("echo")); const r=await tools.mcp__demo__echo({value:"hello"}); text(r);' }),
    says("Done."),
  ]));
  expect(fixture.calls).toMatchObject([{ toolName: "echo", arguments: { value: "hello" } }]);
  const child = t.events.toolResultsFor("mcp__demo__echo")[0];
  expect(child.parentToolCallId).toBe(t.events.toolResultsFor("codemode")[0].toolCallId);
  expect(child.structuredContent).toMatchObject({ structuredContent: { value: "hello" } });
  expect(child.mocked).toBe(false);
} finally {
  await t.close();
}
expect(fixture.closed).toBe(true);
```

`createMcpFixture` accepts native MCP `Tool` definitions and a fixed response or asynchronous handler per tool. Return a native `CallToolResult` to represent success or an MCP tool error (`isError: true`). Return `{ error: { code, message, data? } }` for a JSON-RPC protocol error. A thrown handler becomes an explicit internal protocol error. Unknown methods/tools fail instead of returning a default success. The fixture supports initialization, discovery and tool calls only. It uses Pi's official in-memory transport and never spawns the configured placeholder command.

`extensionOptions` returns fresh options for each factory composition, with configuration and logs isolated to the session cwd. Use one fixture per test session. `calls` records received MCP calls in receipt order, including request IDs and cloned arguments. `closed` is true before connection and after every transport closes.

Use `exposure: "direct"` for immediate model declarations, `"deferred"` with an explicit `createToolSearchExtension()` for discovery followed by direct calls, `"codemode"` for scripted calls, or `"hidden"` for unreachable tools. `toolExposure` accepts Pi's per-tool overrides. Inspect the prepared transcript with Pi's `getCurrentTools()` when asserting model declarations. Callable tool names and model declarations can differ.

`mockTools` handles direct and nested execution consistently, including asynchronous handlers and `structuredContent`. It replaces execution only, so Pi's validation and hooks still apply. `mocked` is true only if that call actually executed a mock handler. A controlled MCP fixture response is a real native adapter execution and is therefore unmocked. Native MCP results expose the complete MCP result envelope through the Pi result's `structuredContent`, hence the two levels in the example.

Call and result records contain `toolCallId` and optional `parentToolCallId`. Correlate by ID within the current run rather than completion order. Playbook IDs restart on each run. Raw native events remain in `events.all`. Concurrent runs on one session reject. Existing `.then()` callbacks retain their execution-time result semantics, while `events.toolResults` contains final post-hook results.

## Platform Notes

### Windows + SQLite (EPERM in afterEach)

Use `await t.close()` in teardown. It aborts and settles an active run, restores temporary interception, awaits Pi's native `session_shutdown`, then removes the harness-owned temporary directory. A supplied `cwd` is preserved. Repeated `close()` calls share the same operation, and subsequent `run()` calls reject.

`dispose()` remains synchronous for existing consumers and does not emit shutdown. Calling `close()` after `dispose()` rejects because the native extension context has already been invalidated. For native workflows, use `close()` throughout the session's lifetime.

```typescript
afterEach(async () => {
  await t?.close();
});
```

For legacy synchronous cleanup, `safeRmSync` ignores only `EPERM` and `EBUSY`. It does not release database handles or replace a shutdown hook. Native shutdown errors are propagated by the harness where Pi exposes them, but Pi may report extension-handler failures through its error channel. Assert actual resource closure when it matters.

---

## Design Philosophy

> **Let pi be pi.** The less we fake, the more real the test.

The harness minimizes substitution. Extensions load through pi's real loader (jiti). Tools go through pi's real wrapping pipeline. Hooks fire through AgentSession's `beforeToolCall`/`afterToolCall`. Events flow through pi's real event system.

Loading runs in the same loader configuration pi's shipped runtimes use. Pi builds its jiti options from how pi itself is running, and the branch an in-process harness lands on leaves jiti's native import fast-path at a default that depends on the test runner (enabled under Bun, off under Node). That default changes what a path-loaded extension observes — an entrypoint with a module-level `await import(...)` could be handed to pi before its module body finished evaluating. `withoutJitiNativeImport` pins the choice the shipped runtimes make, so `extensions: [...]` behaves the same under vitest and `bun test`.

Only the LLM boundary is replaced — because that's the one thing you **can't** run in a deterministic test. Real-provider smoke tests belong in the application or extension that owns the provider configuration, not in this harness.

## Testing Scope

CI runs in three stages:

1. **Verify** on Linux/Node 24: lint, typecheck, unit tests, build, audit (`sfw npm audit`), and the installed-consumer smoke (`npm run test:consumer`).
2. **Integration matrix** after verify passes: Linux + Windows, Node 22 + 24, Pi 1.1.0 (locked by `devDependencies`).
3. **Bun qualification** after verify passes: Linux, Bun 1.3.14, path-loaded extension cases (`npm run test:bun`), build, and the installed-consumer smoke (`npm run test:consumer -- --runtime=bun`). Bun's extension-loading cases cover the top-level-await regression that the Node runner cannot reproduce.

The consumer smoke installs the root npm tarball and the minimal `dist/package.tgz` independently through Socket Firewall. Exact peer versions come from `devDependencies`, rather than resolving an unspecified new patch from the peer ranges. The same scenario checks package metadata, declarations, the bundled skill, runtime identity, real and mocked tools, single hook emission, hook result modifications, refusal before mock execution, consecutive runs, and callback restoration after success and failure. Session execution rejects unexpected fetch requests and makes no LLM calls.

For nested npm installs, the sandbox and consumer smoke remove `npm run`'s exported `allow-scripts` environment value so npm 12 reads the policy from its configuration files. Other environment settings and direct invocation options are preserved. This does not modify personal npm configuration or bypass Socket Firewall.

The unit suite covers the playbook DSL and subprocess `createMockPi()` shim. The integration suite covers real in-process Pi sessions, extension loading, tool registration/execution, hooks, UI mocking, sandbox package install verification, regression cases, and Windows-safe cleanup behavior.

Known intentional gaps:

- No real LLM/provider calls; the harness replaces the model boundary by design.
- No compatibility testing for the deprecated `@mariozechner/*` Pi packages or Pi outside 1.1.x. The qualification baseline is pinned to Pi 1.1.0.
- Concurrent/parallel tool execution is not yet deeply exercised. Today the playbook emits one tool call per assistant message, which is deterministic and good for most extension tests. To test true Pi parallelism, the harness should grow a grouped/batched call action that emits multiple `toolCall` blocks in one assistant message, then assert result collection by `toolCallId` rather than completion order.
- Native MCP/codemode qualification covers the in-memory transport and explicit Pi factories. OAuth, `models.*`, resources, reconnection and real stdio/HTTP transport workflows are outside this coverage. Third-party extension/package workflows and concurrent `createMockPi()` subprocess consumers are excluded.
- The new source scenarios and installed artifacts run in CI on Node 22/24 Linux/Windows, with installed-artifact coverage on Bun 1.3.14 Linux. Windows must pass before publication. A configured CI job is not evidence that the current revision has passed it.

## Releasing

Releases are driven by [changesets](https://github.com/changesets/changesets) and published from CI with npm Trusted Publishing (OIDC) — the repository holds no `NPM_TOKEN`.

1. Add a changeset for the change (`npm exec --no -- changeset`) and merge it alongside the work.
2. Run the **Release** workflow (`workflow_dispatch`) on `main` — the base branch changesets reads. With pending changesets it opens a `chore: version packages` PR carrying the version bump and the changelog.
3. Merge that PR, then run the workflow again: nothing is left to version, so it publishes to npm, creates the `v<version>` tag, and creates the GitHub Release from that version's changelog entry.
4. Read **Release summary** on the workflow run's Summary page. It lists the target version and commit, dependency install/build results, version PR, npm publication, remote tag, and GitHub Release, with links and reasons for skipped operations. The summary also runs after failures. A failed publishing step can have published to npm before failing, so its publication result is shown as unconfirmed rather than assuming nothing happened.

The workflow uses Changesets action v2 with CLI v3, which communicates release results through a structured output file instead of parsing console messages. An npm preflight distinguishes a new publication from a version that was already available. If a version is already on npm, this workflow skips remote tag and GitHub Release creation. Recover missing release metadata separately at the package's original npm `gitHead`, rather than tagging a later commit. This single-package repository uses the `v<version>` tag.

For a release prepared locally, apply its pending changeset with `npm exec --no -- changeset version`, then synchronize the npm lockfile and qualify the resulting artifacts. Once that version commit has passed CI and publication is explicitly authorized, the manual Release workflow can publish it without an intermediate version PR. Local qualification does not publish or install the package into a daily Pi runtime.

One-time prerequisite: on npmjs.com, the package's trusted publisher must name this repository and the `release` workflow. A local `npm publish` still works as a manual escape hatch, but it carries no provenance.

Consumer-side this changes nothing: install the published version, or keep a `file:`/linked dependency while developing the harness itself (see [Ways to install it](#ways-to-install-it)).

## Upstream

Forked from [@marcfargas/pi-test-harness](https://github.com/marcfargas/pi-test-harness). Upstream history is preserved in the CHANGELOG.

## License

MIT
