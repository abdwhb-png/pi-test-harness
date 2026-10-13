---
"@abdwhb-png/pi-test-harness": minor
---

Add native Pi MCP/codemode testing with explicit Pi factories, a reusable in-memory MCP fixture, structured results and parent/child call observations. Apply asynchronous mocks consistently to direct and nested calls and record their actual execution provenance. Add `close()` to await native shutdown before cleaning up owned state, retaining synchronous `dispose()` for compatibility.

Declare the native `@earendil-works/pi-mcp` and `@earendil-works/pi-codemode` peers and qualify the new workflows through both installed artifacts on Node and Bun. Windows qualification is required before publication.

Constrain codemode to the Pi 1.1 line: fresh installs otherwise resolve codemode 1.2 from Pi coding-agent's broad transitive range, which lacks exports required by Pi 1.1.
