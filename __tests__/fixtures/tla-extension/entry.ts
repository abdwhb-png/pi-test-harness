/**
 * Fixture entrypoint reproducing the shape that broke extension loading.
 *
 * Mirrors a real extension entrypoint (`pi-subagents/index.ts`):
 *
 *   const registerParentExtension = (await import("./src/extension/index.ts")).default;
 *   export default function registerSubagentExtension(pi) {
 *       registerParentExtension?.(pi);
 *   }
 *
 * The module-level `await import(...)` binds a top-level `const`, while the
 * default export is a hoisted function declaration that closes over it. If the
 * loader hands back this module's factory before the entry body finishes
 * evaluating, calling it throws a TDZ ReferenceError on `registerFixture`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RegisterFixture } from "./impl";

const registerFixture = (await import("./impl")).default as RegisterFixture;

export default function registerTlaEntrypoint(pi: ExtensionAPI): void {
 registerFixture(pi);
}
