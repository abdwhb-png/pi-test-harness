/**
 * Control entrypoint: identical registration, reached through a static import
 * instead of a module-level `await import(...)`.
 *
 * Isolates top-level await as the variable. If this fixture fails, the problem
 * is not top-level await.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerFixture from "./impl";

export default function registerStaticEntrypoint(pi: ExtensionAPI): void {
 registerFixture(pi);
}
