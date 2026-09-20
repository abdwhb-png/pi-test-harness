/**
 * Shared fixtures access and observation helpers for extension loading.
 *
 * The same loader contract has to hold under both runtimes the harness runs in:
 * vitest on Node (the repo's runner) and `bun test` (the runtime the real
 * agent's extension probe uses). The two runners disagree about jiti's native
 * import fast-path, which is exactly what the top-level-await regression was
 * about — so both must exercise these cases.
 *
 * Assertions live in each runner's own test file; this module owns the fixture
 * wiring and the observations so the contract has a single definition.
 */

import * as path from "node:path";
import { createTestSession } from "../src/index.js";
import {
	TLA_FIXTURE_COMMAND_NAME,
	TLA_FIXTURE_MARKER,
	TLA_FIXTURE_TOOL_NAME,
} from "./fixtures/tla-extension/impl.js";
import { FACTORY_FIXTURE_TOOL_NAME } from "./fixtures/tla-extension/factory-entry.js";

/** Absolute path to the fixture directory. */
const FIXTURES_DIR = path.join(
	import.meta.dirname,
	"fixtures",
	"tla-extension",
);

/** Resolve a fixture file name to an absolute path. */
export function fixture(name: string): string {
	return path.join(FIXTURES_DIR, name);
}

/** What Pi actually received for one path-loaded extension. */
export interface LoadObservation {
	/** Rendered `extensionsResult.errors`, empty when the load was clean. */
	extensionErrors: string[];
	/** Number of extensions the loader produced. */
	extensionCount: number;
	/** Tool names registered by the extension itself. */
	registeredTools: string[];
	/** Tool labels, which carry values produced inside the awaited module. */
	registeredToolLabels: string[];
	/** Command names registered by the extension itself. */
	registeredCommands: string[];
	/** Tool names visible in the real session tool registry. */
	sessionTools: string[];
}

/**
 * Load `entry` through the public `createTestSession` boundary and report what
 * the loader and the session ended up with.
 */
export async function observeLoad(entry: string): Promise<LoadObservation> {
	const t = await createTestSession({ extensions: [entry] });
	try {
		const loaded = t.session.resourceLoader.getExtensions();
		const extension = loaded.extensions[0];
		return {
			extensionErrors: loaded.errors.map((e) => `${e.path}: ${e.error}`),
			extensionCount: loaded.extensions.length,
			registeredTools: extension ? [...extension.tools.keys()] : [],
			registeredToolLabels: extension
				? [...extension.tools.values()].map((tool) => tool.definition.label)
				: [],
			registeredCommands: extension ? [...extension.commands.keys()] : [],
			sessionTools: t.session.agent.state.tools.map((tool) => tool.name),
		};
	} finally {
		t.dispose();
	}
}

/**
 * Load `entry`, expecting the load to fail, and return the surfaced message.
 *
 * Returns the message instead of throwing so each runner can assert in its own
 * style. `undefined` means the load unexpectedly succeeded.
 */
export async function observeLoadFailure(
	entry: string,
): Promise<string | undefined> {
	try {
		const observation = await observeLoad(entry);
		return observation.extensionErrors.length > 0
			? observation.extensionErrors.join("\n")
			: undefined;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

/** One path-loaded extension and the registrations it must produce. */
export interface LoadingCase {
	name: string;
	entry: string;
	toolName: string;
	/** Exact command names the entry is expected to register. */
	commandNames: string[];
	/** Substring that must appear in the tool label; a value from the awaited module. */
	labelMarker?: string;
}

/** Cases shared by the vitest suite and the Bun smoke. */
export const loadingCases: LoadingCase[] = [
	{
		name: "top-level await entrypoint",
		entry: fixture("entry.ts"),
		toolName: TLA_FIXTURE_TOOL_NAME,
		commandNames: [TLA_FIXTURE_COMMAND_NAME],
		labelMarker: TLA_FIXTURE_MARKER,
	},
	{
		name: "static-import entrypoint",
		entry: fixture("static-entry.ts"),
		toolName: TLA_FIXTURE_TOOL_NAME,
		commandNames: [TLA_FIXTURE_COMMAND_NAME],
		labelMarker: TLA_FIXTURE_MARKER,
	},
	{
		name: "plain factory entrypoint",
		entry: fixture("factory-entry.ts"),
		toolName: FACTORY_FIXTURE_TOOL_NAME,
		commandNames: [],
	},
];

/** Entrypoint whose awaited implementation throws while evaluating. */
export const brokenCase = fixture("broken-entry.ts");
