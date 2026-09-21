---
"@abdwhb-png/pi-test-harness": minor
---

Load extensions in Pi's shipped loader configuration, and move the supported Pi line to 0.85.

Path-loaded extensions (`extensions: [...]`) could fail with `Cannot access 'x' before initialization` when the test runner was Bun. Pi builds its jiti options from how Pi itself is running, and the branch an in-process harness lands on left jiti's native import fast-path at its default — enabled when Bun is detected, off under Node. Under Bun that path handed Pi a factory for an entrypoint whose module body had not finished evaluating, so any extension using a module-level `await import(...)` threw a TDZ error instead of loading. The harness now pins the choice Pi's shipped runtimes make (`tryNative: false`) around extension evaluation, so loading behaves the same under vitest and `bun test`.

Also in this change:

- The supported Pi line is now `^0.85.0` (`devDependencies` locked to 0.85.1), replacing `^0.84.0`.
- New path-loaded extension coverage: a top-level-await fixture, static-import and plain-factory controls, and a failing-implementation case. It runs under vitest (`__tests__/extension-loading.test.ts`) and under Bun (`npm run test:bun`), with a CI job for the Bun side — the vitest suite alone cannot catch this class of regression.
- The packed-consumer smoke now installs the peers declared in `package.json` instead of a hardcoded Pi version, which had drifted two lines behind the manifest.
