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
	type ToolDefinition,
	ModelRuntime,
	AgentSessionRuntime,
	createAgentSessionFromServices,
} from "@earendil-works/pi-coding-agent";
import { createPlaybookStreamFn, type PlaybookState } from "./playbook.js";
import { createMockExecute, interceptToolExecution } from "./mock-tools.js";
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
	let interceptDefinitions = () => {};
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
	// Pi synchronizes runtime credentials with an offline model refresh.
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
	let mockedIds = new Set<string>();
	const callsById = new Map<string, ToolCallRecord>();
	const blockedById = new Map<string, string>();

	session.subscribe((event: AgentSessionEvent) => {
		events.all.push(event);

		if (event.type === "tool_execution_start") {
			// Nested execution dereferences the public definition after this event.
			interceptDefinitions();
			const record: ToolCallRecord = {
				step: currentStep,
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				parentToolCallId: event.parentToolCallId,
				input: (event as any).args ?? {},
				blocked: false,
			};
			events.toolCalls.push(record);
			callsById.set(event.toolCallId, record);
		}

		if (event.type === "tool_execution_end") {
			const resultText =
				event.result?.content
					?.filter((c: any) => c.type === "text")
					?.map((c: any) => c.text)
					?.join("\n") ?? "";

			const call = callsById.get(event.toolCallId);
			if (call && blockedById.has(event.toolCallId)) {
				call.blocked = true;
				call.blockReason = blockedById.get(event.toolCallId);
			}

			// Record the final result (after afterToolCall modifications).
			// Always push — each tool_execution_end has a unique toolCallId
			// within a run, and the subscriber is the only source of results.
			const isMocked = mockedIds.has(event.toolCallId);
			events.toolResults.push({
				step: currentStep,
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				parentToolCallId: event.parentToolCallId,
				text: resultText,
				content: event.result?.content ?? [],
				isError: event.isError,
				details: event.result?.details,
				structuredContent: event.result?.structuredContent,
				mocked: isMocked,
			});
		}

		if (event.type === "message_end") {
			events.messages.push(event.message);
		}
	});

	let playbookState: PlaybookState | null = null;
	let running = false;
	let runSettled: Promise<void> = Promise.resolve();
	let disposed = false;
	let closePromise: Promise<void> | undefined;
	const services = { cwd, agentDir: cwd, modelRuntime, settingsManager, resourceLoader: loader, diagnostics: [] };
	const runtime = new AgentSessionRuntime(session, services, async ({ sessionManager }) => ({
		...await createAgentSessionFromServices({ services, sessionManager, model: playbookModel }),
		services,
		diagnostics: [],
	}));

	const mockUI = createMockUIContext(options.mockUI, events.ui);

	await session.bindExtensions({
		uiContext: mockUI,
		onError: (err) => {
			console.error(
				`[pi-test-harness] Extension error: ${err.event} — ${err.error}`,
			);
		},
	});

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
			if (disposed || closePromise) throw new Error("Test session is closed");
			if (running) throw new Error("A test session run is already active");
			running = true;
			let finishRun!: () => void;
			runSettled = new Promise(resolve => { finishRun = resolve; });
			const { streamFn, state } = createPlaybookStreamFn(turns);
			playbookState = state;

			// Assign playbook streamFn to the public Agent.streamFunction
			session.agent.streamFunction = streamFn;

			const effectiveMockTools = options.mockTools ?? {};
			mockedIds = new Set<string>();
			callsById.clear();
			blockedById.clear();
			const runner = session.extensionRunner;
			const originalEmitToolCall = runner?.emitToolCall;
			if (runner && originalEmitToolCall) {
				runner.emitToolCall = async function (event) {
					const result = await originalEmitToolCall.call(this, event);
					if (result?.block) blockedById.set(event.toolCallId, result.reason || "Tool execution was blocked");
					return result;
				};
			}
			const definitions = new Map<ToolDefinition, ToolDefinition["execute"]>();
			interceptDefinitions = () => {
				for (const [name, handler] of Object.entries(effectiveMockTools)) {
					const definition = session.getToolDefinition(name);
					if (!definition || definitions.has(definition)) continue;
					definitions.set(definition, definition.execute);
					definition.execute = createMockExecute(name, handler, state, mockedIds);
				}
			};
			const originalPrepareRequest = session.agent.prepareRequest;
			session.agent.prepareRequest = async (request, signal) => {
				const update = await originalPrepareRequest?.(request, signal);
				const context = update?.context ?? request.context;
				const tools = interceptToolExecution(
					context.tools ?? [],
					effectiveMockTools,
					state,
					propagateErrors,
					mockedIds,
				);
				// Pi executes this request snapshot after rebuilding its tool registry.
				return { ...update, context: { ...context, tools } };
			};
			try {
				for (const turn of turns) {
					if (closePromise) break;
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
			} finally {
				session.agent.prepareRequest = originalPrepareRequest;
				interceptDefinitions = () => {};
				for (const [definition, execute] of definitions) definition.execute = execute;
				if (runner && originalEmitToolCall) runner.emitToolCall = originalEmitToolCall;
				running = false;
				finishRun();
			}
		},

		close(): Promise<void> {
			if (closePromise) return closePromise;
			if (disposed) return Promise.reject(new Error("Test session was disposed before close()"));
			closePromise = (async () => {
				await session.abort();
				await runSettled;
				await runtime.dispose();
				disposed = true;
				if (ownsTmpDir) fs.rmSync(cwd, { recursive: true, force: true });
			})();
			return closePromise;
		},

		/**
		 * Dispose the test session and clean up the temp directory (if owned).
		 *
		 * `session.dispose()` does not emit `session_shutdown`. Resources closed
		 * only by shutdown hooks can remain open until reload or CLI shutdown.
		 * Use `safeRmSync` for extension-owned files locked on Windows.
		 */
		dispose(): void {
			if (disposed || closePromise) return;
			disposed = true;
			session.dispose();
			if (ownsTmpDir && fs.existsSync(cwd)) {
				fs.rmSync(cwd, { recursive: true, force: true });
			}
		},
	};

	return testSession;
}
