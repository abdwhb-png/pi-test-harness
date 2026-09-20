/**
 * Negative half of the fixture: the awaited implementation throws while it
 * evaluates.
 *
 * Guarantees the harness keeps surfacing extension load failures instead of
 * silently treating a failed entrypoint as "no extension".
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const BROKEN_IMPL_MESSAGE = "tla-fixture-broken-impl";

export default function registerBrokenFixture(_pi: ExtensionAPI): void {
 throw new Error(BROKEN_IMPL_MESSAGE);
}
