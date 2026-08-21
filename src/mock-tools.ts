/**
 * Tool execution interceptor — wraps tool.execute() for tools in mockTools.
 *
 * For mocked tools, the mock replaces tool.execute() and returns controlled
 * values. Extension hooks (tool_call / tool_result) are handled by
 * AgentSession 0.83's internal beforeToolCall/afterToolCall — the mock
 * must NOT re-emit them.
 *
 * For non-mocked tools, the real execute() is called and results are
 * collected for event queries.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { MockToolHandler, ToolResult, ToolResultRecord } from "./types.js";
import type { PlaybookState } from "./playbook.js";
import { formatToolError } from "./diagnostics.js";

/**
 * Thrown when an extension hook blocks a tool call.
 * Exported for test assertions — no longer thrown by the mock itself since
 * AgentSession 0.83's beforeToolCall handles blocking before execute().
 */
export class ToolBlockedError extends Error {
	readonly toolBlocked = true as const;

	constructor(reason: string) {
		super(reason);
		this.name = "ToolBlockedError";
	}
}

/**
 * Returns true if `err` represents a hook-based tool block.
 *
 * Kept for consumers that catch errors from tool execution flows, though
 * AgentSession 0.83's beforeToolCall blocks before execute() is reached.
 */
export function isBlockedError(err: unknown): boolean {
	if (err instanceof ToolBlockedError) return true;
	if (err instanceof Error) {
		const msg = err.message;
		return (
			msg.includes("blocked") ||
			msg.includes("Plan mode") ||
			msg.includes("WRITE operation")
		);
	}
	return false;
}

function normalizeMockResult(
	handler: MockToolHandler,
	params: Record<string, unknown>,
): ToolResult {
	let raw: string | ToolResult;

	if (typeof handler === "string") {
		raw = handler;
	} else if (typeof handler === "function") {
		raw = handler(params);
	} else {
		raw = handler;
	}

	if (typeof raw === "string") {
		return {
			content: [{ type: "text", text: raw }],
			details: {},
		};
	}

	return raw;
}

/**
 * Intercept tool execution for mocked tools.
 *
 * Unlike the old approach, this does NOT emit tool_call/tool_result hooks
 * manually — AgentSession 0.83's beforeToolCall/afterToolCall handles that.
 * The mock only replaces execute() to return controlled values. Result
 * recording is handled by the session subscriber from tool_execution_end
 * events (which carry the final afterToolCall-modified result).
 *
 * Returns a Set of mocked tool names for the session subscriber to set the
 * mocked flag on recorded results, plus a Set of toolCallIds whose mock
 * returned a ToolResult with isError:true. Pi 0.84's agent loop hardcodes
 * successful execute() as non-error (isError:false), so the subscriber must
 * consult this set to preserve the mock's error intent in collected records.
 */
export function interceptToolExecution(
	tools: AgentTool[],
	mockTools: Record<string, MockToolHandler>,
	playbookState: PlaybookState,
	propagateErrors: boolean,
): {
	tools: AgentTool[];
	mockedNames: ReadonlySet<string>;
	mockedErrorToolCallIds: ReadonlySet<string>;
} {
	const mockedNames = new Set(Object.keys(mockTools));
	const mockedErrorToolCallIds = new Set<string>();

	const wrapped = tools.map((tool) => {
		const mockHandler = mockTools[tool.name];
		if (!mockHandler) {
			return wrapForCollection(tool, playbookState, propagateErrors);
		}

		return {
			...tool,
			execute: async (
				toolCallId: string,
				params: Record<string, unknown>,
				_signal?: AbortSignal,
				_onUpdate?: any,
			) => {
				const result = normalizeMockResult(mockHandler, params);
				const text = result.content
					.filter((c) => c.type === "text")
					.map((c) => c.text)
					.join("\n");
				if (result.isError) {
					// Pi 0.84 hardcodes successful execute() as non-error; remember the
					// toolCallId so the session subscriber can flag the record.
					mockedErrorToolCallIds.add(toolCallId);
				}
				// fireThenCallback fires synchronously so .then() sees real data
				fireThenCallback(playbookState, toolCallId, {
					step: playbookState.consumed,
					toolName: tool.name,
					toolCallId,
					text,
					content: result.content,
					isError: result.isError ?? false,
					details: result.details,
					mocked: true,
				});

				return {
					content: result.content,
					details: result.details ?? {},
				};
			},
		} as AgentTool;
	});

	return { tools: wrapped, mockedNames, mockedErrorToolCallIds };
}

/**
 * Wrap a real tool for event collection (non-mocked tools).
 * Does not push to toolResults — the session subscriber handles recording
 * from tool_execution_end events.
 */
function wrapForCollection(
	tool: AgentTool,
	playbookState: PlaybookState,
	propagateErrors: boolean,
): AgentTool {
	const originalExecute = tool.execute;

	return {
		...tool,
		execute: async (
			toolCallId: string,
			params: Record<string, unknown>,
			signal?: AbortSignal,
			onUpdate?: any,
		) => {
			const step = playbookState.consumed;

			try {
				const result = await originalExecute.call(
					tool,
					toolCallId,
					params,
					signal,
					onUpdate,
				);

				const text = (result.content ?? [])
					.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join("\n");

				fireThenCallback(playbookState, toolCallId, {
					step,
					toolName: tool.name,
					toolCallId,
					text,
					content: result.content ?? [],
					isError: !!(result as any).isError,
					details: result.details,
					mocked: false,
				});

				return result;
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);

				try {
					fireThenCallback(playbookState, toolCallId, {
						step,
						toolName: tool.name,
						toolCallId,
						text: errMsg,
						content: [{ type: "text", text: errMsg }],
						isError: true,
						details: undefined,
						mocked: false,
					});
				} catch {
					/* best-effort callback */
				}

				if (propagateErrors) {
					const diagnostic = formatToolError(step, tool.name, err);
					throw new Error(diagnostic, { cause: err });
				}

				return {
					content: [{ type: "text", text: errMsg }],
					details: {},
					isError: true,
				};
			}
		},
	} as AgentTool;
}

function fireThenCallback(
	state: PlaybookState,
	toolCallId: string,
	record: ToolResultRecord,
): void {
	const callback =
		state.pendingCallbacks.get(toolCallId) ??
		state.pendingCallbacks.get(record.toolName);
	const key = state.pendingCallbacks.has(toolCallId)
		? toolCallId
		: record.toolName;
	if (callback) {
		state.pendingCallbacks.delete(key);
		try {
			callback(record);
		} catch (err) {
			console.warn(
				`[pi-test-harness] .then() callback error for ${record.toolName}: ${err}`,
			);
		}
	}
}
