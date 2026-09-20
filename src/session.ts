/**
 * TestSession — orchestrates a test run with playbook, mock tools, and mock UI.
 *
 * 1. Creates a real pi environment (extensions, tools, hooks, session)
 * 2. Replaces streamFn with playbook
 * 3. Intercepts tool.execute() for mockTools
 * 4. Injects mock UI context
 * 5. Collects events
 * 6. Runs conversation script
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	type AgentSessionEvent,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createPlaybookStreamFn, type PlaybookState } from "./playbook.js";
import { interceptToolExecution } from "./mock-tools.js";
import { createMockUIContext } from "./mock-ui.js";
import { createEventCollector } from "./events.js";
import { formatPlaybookDiagnostic } from "./diagnostics.js";
import { withoutJitiNativeImport } from "./pi-loader-parity.js";
import type {
	TestSessionOptions,
	TestSession,
	Turn,
	ToolCallRecord,
} from "./types.js";

export async function createTestSession(
	options: TestSessionOptions = {},
): Promise<TestSession> {
	const propagateErrors = options.propagateErrors ?? true;
	const ownsTmpDir = !options.cwd;
	const cwd =
		options.cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-harness-"));

	if (!fs.existsSync(cwd)) {
		fs.mkdirSync(cwd, { recursive: true });
	}

	const settingsManager = SettingsManager.inMemory();
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: cwd, // Use cwd as agent dir to avoid touching real ~/.pi
		settingsManager,
		additionalExtensionPaths:
			options.extensions?.map((p) => path.resolve(cwd, p)) ?? [],
		extensionFactories: options.extensionFactories,
		systemPromptOverride: options.systemPrompt
			? () => options.systemPrompt!
			: undefined,
	});
	// Extensions load here. Pinned to the loader configuration Pi's shipped
	// runtimes use — see withoutJitiNativeImport for why that matters.
	await withoutJitiNativeImport(() => loader.reload());

	// Create isolated ModelRuntime with auth under cwd and no persisted model catalog
	const modelRuntime = await ModelRuntime.create({
		authPath: path.join(cwd, "auth.json"),
		modelsPath: null,
	});

	// Use a builtin model as placeholder (never actually called — playbook replaces streamFn)
	const playbookModel = modelRuntime.getModel("openai", "gpt-4o");
	if (!playbookModel) {
		throw new Error(
			"Model openai/gpt-4o not found in isolated ModelRuntime. " +
				"This should not happen — builtin providers are always registered. " +
				"Check that @earendil-works/pi-ai is installed.",
		);
	}

	// Provide a dummy API key so AgentSession.prompt does not reject before
	// the playbook replaces streamFunction. The key is never sent to any LLM.
	// Pi 0.84 synchronizes runtime credentials with an offline model refresh.
	await modelRuntime.setRuntimeApiKey("openai", "sk-test-harness-dummy");

	const { session, extensionsResult } = await withoutJitiNativeImport(() =>
		createAgentSession({
			cwd,
			agentDir: cwd,
			model: playbookModel,
			modelRuntime,
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			resourceLoader: loader,
		}),
	);

	if (extensionsResult.errors.length > 0) {
		session.dispose();
		if (ownsTmpDir && fs.existsSync(cwd)) {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
		const errors = extensionsResult.errors
			.map((e) => `  ${e.path}: ${e.error}`)
			.join("\n");
		throw new Error(`Extension load errors:\n${errors}`);
	}

	const events = createEventCollector();
	let currentStep = 0;
	let mockedToolNames: ReadonlySet<string> = new Set();
	// toolCallIds whose mock returned a ToolResult with isError:true — Pi 0.84
	// hardcodes successful execute() as non-error, so records must consult this.
	let mockedErrorToolCallIds: ReadonlySet<string> = new Set();

	session.subscribe((event: AgentSessionEvent) => {
		events.all.push(event);

		if (event.type === "tool_execution_start") {
			const record: ToolCallRecord = {
				step: currentStep,
				toolName: event.toolName,
				input: (event as any).args ?? {},
				blocked: false,
			};
			events.toolCalls.push(record);
		}

		if (event.type === "tool_execution_end") {
			const resultText =
				event.result?.content
					?.filter((c: any) => c.type === "text")
					?.map((c: any) => c.text)
					?.join("\n") ?? "";

			if (event.isError) {
				const lastCall = events.toolCalls[events.toolCalls.length - 1];
				if (lastCall && lastCall.toolName === event.toolName) {
					if (resultText.includes("blocked") || resultText.includes("Plan mode")) {
						lastCall.blocked = true;
						lastCall.blockReason = resultText;
					}
				}
			}

			// Record the final result (after afterToolCall modifications).
			// Always push — each tool_execution_end has a unique toolCallId
			// within a run, and the subscriber is the only source of results.
			const isMocked = mockedToolNames.has(event.toolName);
			events.toolResults.push({
				step: currentStep,
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				text: resultText,
				content: event.result?.content ?? [],
				isError: event.isError || mockedErrorToolCallIds.has(event.toolCallId),
				details: event.result?.details,
				mocked: isMocked,
			});
		}

		if (event.type === "message_end") {
			events.messages.push(event.message);
		}
	});

	let playbookState: PlaybookState | null = null;

	const mockUI = createMockUIContext(options.mockUI, events.ui);

	await session.bindExtensions({
		uiContext: mockUI,
		onError: (err) => {
			console.error(
				`[pi-test-harness] Extension error: ${err.event} — ${err.error}`,
			);
		},
	});

	const originalTools: AgentTool[] = [...session.agent.state.tools];

	const testSession: TestSession = {
		session,
		cwd,
		events,

		get playbook() {
			return {
				consumed: playbookState?.consumed ?? 0,
				remaining: playbookState?.remaining ?? 0,
			};
		},

		async run(...turns: Turn[]): Promise<void> {
			const { streamFn, state } = createPlaybookStreamFn(turns);
			playbookState = state;

			// Assign playbook streamFn to the public Agent.streamFunction
			session.agent.streamFunction = streamFn;

			const effectiveMockTools = options.mockTools ?? {};
			const currentTools = originalTools;
			const {
				tools: interceptedTools,
				mockedNames,
				mockedErrorToolCallIds: errorIds,
			} = interceptToolExecution(
				currentTools,
				effectiveMockTools,
				state,
				propagateErrors,
			);
			mockedToolNames = mockedNames;
			mockedErrorToolCallIds = errorIds;
			session.agent.state.tools = interceptedTools;

			for (const turn of turns) {
				currentStep = state.consumed;
				await session.prompt(turn.prompt);
				await session.agent.waitForIdle();
			}

			if (state.remaining > 0) {
				const allActions = turns.flatMap((t) => t.actions);
				const remaining = allActions.slice(state.consumed);
				const diagnostic = formatPlaybookDiagnostic("remaining", state, remaining);
				throw new Error(diagnostic);
			}
		},

		/**
		 * Dispose the test session and clean up the temp directory (if owned).
		 *
		 * Note: `session.dispose()` does NOT fire `session_shutdown`. That event is
		 * dispatched by pi at Node.js process exit. Extensions that open resources in
		 * `session_start` (e.g., SQLite databases) keep those resources open until the
		 * process exit. Use `safeRmSync` when cleaning up extension-owned files in
		 * afterEach hooks on Windows to avoid EPERM errors.
		 */
		dispose(): void {
			session.dispose();
			if (ownsTmpDir && fs.existsSync(cwd)) {
				fs.rmSync(cwd, { recursive: true, force: true });
			}
		},
	};

	return testSession;
}
