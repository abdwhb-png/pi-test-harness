# @abdwhb-png/pi-test-harness

## 0.8.0

### Minor Changes

- [`a9d9e68`](https://github.com/abdwhb-png/pi-test-harness/commit/a9d9e68961492b77fe3663c18621a3c2868d3ede) Thanks [@abdwhb-png](https://github.com/abdwhb-png)! - Load extensions in Pi's shipped loader configuration, and move the supported Pi line to 0.85.

  Path-loaded extensions (`extensions: [...]`) could fail with `Cannot access 'x' before initialization` when the test runner was Bun. Pi builds its jiti options from how Pi itself is running, and the branch an in-process harness lands on left jiti's native import fast-path at its default — enabled when Bun is detected, off under Node. Under Bun that path handed Pi a factory for an entrypoint whose module body had not finished evaluating, so any extension using a module-level `await import(...)` threw a TDZ error instead of loading. The harness now pins the choice Pi's shipped runtimes make (`tryNative: false`) around extension evaluation, so loading behaves the same under vitest and `bun test`.

  Also in this change:

  - The supported Pi line is now `^0.85.0` (`devDependencies` locked to 0.85.1), replacing `^0.84.0`.
  - New path-loaded extension coverage: a top-level-await fixture, static-import and plain-factory controls, and a failing-implementation case. It runs under vitest (`__tests__/extension-loading.test.ts`) and under Bun (`npm run test:bun`), with a CI job for the Bun side — the vitest suite alone cannot catch this class of regression.
  - The packed-consumer smoke now installs the peers declared in `package.json` instead of a hardcoded Pi version, which had drifted two lines behind the manifest.

### Patch Changes

- [`de34f11`](https://github.com/abdwhb-png/pi-test-harness/commit/de34f11ce169bae85ce2fa9fc3acede724e7c8ef) Thanks [@abdwhb-png](https://github.com/abdwhb-png)! - Clear all open dependency advisories, and take vitest to 5.

  `sfw npm audit` reported 6 vulnerabilities (3 moderate, 3 high) in the dev tooling — vitest's mocker, postcss, nanoid, brace-expansion and js-yaml — which made the verify job's audit step fail. `vitest` moves from 3.2.7 to 5.0.1 and the remaining transitive advisories are resolved, taking the audit to zero. The suite needed no configuration change for vitest 5.

- [`87bd1c0`](https://github.com/abdwhb-png/pi-test-harness/commit/87bd1c0ec7c84b62ed29f887bccc062b082c7fea) Thanks [@abdwhb-png](https://github.com/abdwhb-png)! - Upgrade the harness to Pi 0.84 and keep runtime API-key initialization offline through Pi's native synchronization path.

  (The packed consumer smoke test installs the peers declared in `package.json` as of the 0.85 upgrade, so it is no longer pinned to a literal Pi version here.)

## 0.7.0

### Major Changes

- [`fork`](https://github.com/abdwhb-png/pi-test-harness) Thanks [@abdwhb](https://github.com/abdwhb)! — Fork from `@marcfargas/pi-test-harness@0.6.1`. Pi 0.83.0 compatibility milestone.

  **Breaking: Pi `^0.83.0` required.** Drops support for Pi `<0.83.0`.

  - **`ModelRuntime` isolation** — `createTestSession()` creates an isolated `ModelRuntime` with `authPath` under the working directory and `modelsPath: null`. No credentials file is read from `~/.pi/agent`. A dummy API key is set on the openai provider to satisfy AgentSession auth checks (the model is never called — playbook replaces `streamFunction`).

  - **Public Agent APIs** — The harness now accesses `session.agent.streamFunction`, `session.agent.state.tools`, and `session.agent.waitForIdle()` through the public typed API surface of Pi 0.83's `Agent` class. No more `(agent as any).streamFn` casts.

  - **AgentSession typed** — `TestSession.session` is typed as `AgentSession` from `@earendil-works/pi-coding-agent`.

  - **Hook pipeline — single source of truth** — AgentSession 0.83 installs `beforeToolCall`/`afterToolCall` hooks on the Agent, which drive the extension `tool_call`/`tool_result` events. The harness mock no longer re-emits these hooks manually. Each hook fires exactly once per tool call. Tool result modification via `tool_result` hook return values works correctly because the subscriber reads the finalized result from `tool_execution_end`.

  - **Removed `ExtensionRunner` dependency from mock-tools** — `interceptToolExecution()` no longer takes an `extensionRunner` parameter. Mock wrappers only replace `tool.execute()`; hook dispatch is handled by AgentSession.

  - **`ExtensionUIContext` — 0.83 members** — `createMockUIContext()` returns a properly typed `ExtensionUIContext` with all 0.83 members: `setWorkingVisible`, `setWorkingIndicator`, `setHiddenThinkingLabel`, `addAutocompleteProvider`, `getEditorComponent`. No `any` casts on the return type.

  - **`SandboxOptions.npmCommand`** — New option to specify a custom npm command for `verifySandboxInstall()`. Default resolves to the platform npm. Use `["sfw", "npm"]` to route through Socket Firewall, or provide any `execFileSync`-compatible argv. A nonexistent command produces a clear `ENOENT` error.

  - **`ToolBlockedError` kept for compat** — Still exported but no longer thrown in the normal mock flow. AgentSession 0.83 blocks tools via `beforeToolCall` before `execute()` is reached. Consumers can use `ToolBlockedError` for instanceof checks on errors from event callbacks.

  - **`session_shutdown` note** — `session.dispose()` does NOT fire `session_shutdown`. That event fires at Node.js process exit. Extension-owned resources (e.g., SQLite handles) remain open until then.

  - **Package identity** — Renamed to `@abdwhb-png/pi-test-harness@0.7.0`. Repository/homepage/bugs point to `abdwhb-png/pi-test-harness`. Peer dependencies narrowed to `^0.83.0`. Dev dependencies pinned to exact `0.83.0`.

  - **CI** — Verify job runs `sfw npm ci` and `sfw npm audit`. Integration tests Node 22 and 24 on Linux and Windows with Pi 0.83. Release workflow changed to manual (`workflow_dispatch`).

  - **Consumer smoke** — Uses `sfw npm install` with exact `0.83.0` peers, runs a real say-only session, and asserts consumption.

## 0.6.1

### Patch Changes

- [`0236306`](https://github.com/marcfargas/pi-test-harness/commit/02363061622b5255fe2905867ec68e7bc0270d8b) Thanks [@marcfargas](https://github.com/marcfargas)! - Fix release metadata after the 0.6.0 migration release.

## 0.6.0

### Minor Changes

- [`10eb126`](https://github.com/marcfargas/pi-test-harness/commit/10eb1268fb82eb567ee8ba3e47fb942c5ee40795) Thanks [@marcfargas](https://github.com/marcfargas)! - Migrate the harness to the current `@earendil-works/*` Pi packages and require Pi `>=0.74.0`.

  This drops direct support for the deprecated `@mariozechner/*` Pi package names, updates the harness for current Pi session/tool APIs, and adds CI coverage across Linux and Windows against the latest patch releases of the last two supported Pi minor lines.

## 0.5.0

### Minor Changes

- [#3](https://github.com/marcfargas/pi-test-harness/pull/3) [`225e123`](https://github.com/marcfargas/pi-test-harness/commit/225e123ce6ce2790f739aa3083ad1add3f09e752) Thanks [@marcfargas](https://github.com/marcfargas)! - Add `ToolBlockedError` and `safeRmSync` to the public API.

  **`ToolBlockedError`** — a typed error class thrown when an extension hook blocks a mocked tool call. Use `instanceof ToolBlockedError` to distinguish hook blocks from real execution errors in tests, instead of matching error message strings.

  ```ts
  import { ToolBlockedError } from "@marcfargas/pi-test-harness";

  // Test that a blocked call doesn't crash, just records an error
  const result = t.events.toolResultsFor("bash")[0];
  expect(result.isError).toBe(true);

  // Or catch it where propagateErrors is relevant
  try {
    await t.run(when("Try write", [calls("bash", {}), says("Done.")]));
  } catch (err) {
    if (err instanceof ToolBlockedError) {
      // Expected — extension hook blocked the call
    } else throw err;
  }
  ```

  **`safeRmSync(filePath)`** — removes a file, swallowing `EPERM` and `EBUSY` errors only. Intended for `afterEach` cleanup of extension-owned SQLite files on Windows, where `session_shutdown` (which closes DB connections) fires at process exit rather than on `session.dispose()`.

  ```ts
  import { safeRmSync } from "@marcfargas/pi-test-harness";

  afterEach(() => {
    t?.dispose();
    safeRmSync(dbPath);
    safeRmSync(dbPath + "-wal");
    safeRmSync(dbPath + "-shm");
  });
  ```

### Patch Changes

- [#3](https://github.com/marcfargas/pi-test-harness/pull/3) [`225e123`](https://github.com/marcfargas/pi-test-harness/commit/225e123ce6ce2790f739aa3083ad1add3f09e752) Thanks [@marcfargas](https://github.com/marcfargas)! - Fix tool event collection and block detection.

  - **`toolResultsFor()` / `toolCallsFor()` now work without `mockTools`**. Previously these always returned `[]` when `mockTools` was not configured, because real tools were not wrapped for collection. Now all tools are always wrapped, regardless of whether mocks are configured.

  - **Fix double-wrapping on multiple `run()` calls**. Calling `run()` twice in one test would wrap already-wrapped tools again, causing double-counted results and incorrect step numbers. The original tools are now captured once at session creation and reused on every `run()` call.

  - **Fix block detection regression in `wrapForCollection`**. The `ToolBlockedError` class is thrown by the harness's own mock block path, but pi's native hook chain throws a plain `Error` with a message. Block detection now uses a hybrid check (`instanceof ToolBlockedError` + message fallback) so both paths are correctly classified as blocks rather than test failures.

## 0.4.1

### Patch Changes

- [`58693d2`](https://github.com/marcfargas/pi-test-harness/commit/58693d2bab91651fe647dffe740643ab3af13cbf) Thanks [@marcfargas](https://github.com/marcfargas)! - Address code review findings for v0.4.0 standalone release.

  - **Breaking**: Remove deprecated `call()`/`say()` DSL aliases (use `calls()`/`says()` instead)
  - Fix diagnostic messages to reference current `calls()`/`says()` API names
  - Fix release workflow for npm Trusted Publishers (`--provenance`)
  - Record all mock UI method calls for assertion consistency (`setFooter`, `setHeader`, etc.)
  - Scope playbook `toolCallCounter` to factory closure for concurrency safety
  - Add `verifySandboxInstall()` test suite (4 tests with dummy extension fixture)
  - Update package description to mention all three test layers

## 0.4.0

### Minor Changes

- [`688e5fa`](https://github.com/marcfargas/pi-mf-extensions/commit/688e5faa29a1c2673699d5e120b95b619e451ae6) Thanks [@marcfargas](https://github.com/marcfargas)! - Ship compiled `.js` + `.d.ts` output instead of raw TypeScript sources

  Previously, the package shipped only `.ts` source files and relied on consumers having a TypeScript-aware loader (jiti, vitest). Node 24's `--experimental-strip-types` refuses to process `.ts` files inside `node_modules/`, making the package unusable with `node --test` or any Node-native test runner.

  Now:

  - Package exports point to pre-compiled `dist/index.js` (with `dist/index.d.ts` for types)
  - Source `.ts` files are still included for debugging/source maps
  - Build step (`tsc -p tsconfig.build.json`) runs automatically before publish via `prepublishOnly`

## 0.3.0

### Minor Changes

- Rename DSL: `call()` → `calls()`, `say()` → `says()`.

  The new names read more naturally as playbook declarations:
  `when("Deploy", [calls("bash", ...), says("Done.")])` reads as
  "when prompted 'Deploy', the model calls bash then says 'Done.'"

  The old `call()` and `say()` are kept as deprecated aliases (removal in v0.4).

## 0.2.0

### Minor Changes

- Initial release.

  - Playbook DSL (`when`, `call`, `say`) for scripting agent conversations without LLM calls
  - `createTestSession()` — creates real pi `AgentSession` with extension loading, hooks, and events
  - Mock tool execution — intercept `tool.execute()` per-tool with static, dynamic, or full result handlers
  - Mock UI context — configurable responses for `confirm`, `select`, `input`, `editor` with call recording
  - Event collection — query helpers for tool calls, tool results, blocked calls, UI interactions, and messages
  - Late-bound params and `.then()` callbacks for dynamic multi-step tool flows
  - Playbook diagnostics — clear error messages on exhausted/unconsumed actions with step-level detail
  - Error propagation control — abort on real tool throw (default) or capture as error results
  - `verifySandboxInstall()` — npm pack → temp install → verify extensions and tools load correctly

### Patch Changes

- Fix mocked tools bypassing extension hooks (tool_call/tool_result).

  - Mocked tools now fire `emitToolCall`/`emitToolResult` via the extension runner,
    so extension blocking (e.g., plan mode) works correctly in tests
  - Blocked tool results are recorded in `toolResults` before throwing
  - `wrapForCollection` now propagates `isError` from real tool results (was hardcoded `false`)
  - Hook-blocked tools no longer treated as test failures with `propagateErrors: true`
