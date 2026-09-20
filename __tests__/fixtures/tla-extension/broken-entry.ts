/**
 * Negative entrypoint: top-level `await import(...)` of an implementation that
 * throws during evaluation.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RegisterFixture } from "./impl";

const registerBrokenFixture = (await import("./broken-impl"))
 .default as RegisterFixture;

export default function registerBrokenEntrypoint(pi: ExtensionAPI): void {
 registerBrokenFixture(pi);
}
