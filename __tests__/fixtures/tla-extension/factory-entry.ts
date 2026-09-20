/**
 * Control entrypoint: no import indirection at all.
 *
 * Registers a tool and a command directly from a bare default-export factory,
 * the shape every other harness test already covers via `extensionFactories`.
 * This is the "should always be green" baseline for a path-loaded extension.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const FACTORY_FIXTURE_TOOL_NAME = "factory_fixture_tool";

export default function registerFactoryEntrypoint(pi: ExtensionAPI): void {
	pi.registerTool({
		name: FACTORY_FIXTURE_TOOL_NAME,
		label: "Factory fixture",
		description: "Tool registered from a plain factory entrypoint",
		parameters: Type.Object({
			value: Type.String({ description: "Echoed back by the fixture tool" }),
		}),
		execute: async (_id, params) => ({
			content: [{ type: "text", text: `factory:${params.value}` }],
			details: {},
		}),
	});
}
