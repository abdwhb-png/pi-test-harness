/**
 * Implementation half of the top-level-await fixture.
 *
 * Reached only through the entrypoint's module-level `await import("./impl")`,
 * so nothing here runs if that import is skipped, truncated, or resolved before
 * the entry module finishes evaluating.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Marker exported from this module and strung into the registered tool's label.
 * Asserting on it proves the awaited module body actually completed, not just
 * that an import promise resolved.
 */
export const TLA_FIXTURE_MARKER = "impl-evaluated";

export const TLA_FIXTURE_TOOL_NAME = "tla_fixture_tool";

export const TLA_FIXTURE_COMMAND_NAME = "tla-fixture-command";

export type RegisterFixture = (pi: ExtensionAPI) => void;

export default function registerFixture(pi: ExtensionAPI): void {
	pi.registerCommand(TLA_FIXTURE_COMMAND_NAME, {
		description: "Command registered from a top-level-await extension entrypoint",
		handler: async () => {},
	});

	pi.registerTool({
		name: TLA_FIXTURE_TOOL_NAME,
		label: `TLA fixture (${TLA_FIXTURE_MARKER})`,
		description: "Tool registered from a top-level-await extension entrypoint",
		parameters: Type.Object({
			value: Type.String({ description: "Echoed back by the fixture tool" }),
		}),
		execute: async (_id, params) => ({
			content: [{ type: "text", text: `tla:${params.value}` }],
			details: {},
		}),
	});
}
