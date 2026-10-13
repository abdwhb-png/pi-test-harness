/**
 * Tool execution interceptor — wraps tool.execute() for tools in mockTools.
 *
 * For mocked tools, the mock replaces tool.execute() and returns controlled
 * values. Extension hooks (tool_call / tool_result) are handled by
 * AgentSession's internal beforeToolCall/afterToolCall — the mock
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
 * AgentSession's beforeToolCall handles blocking before execute().
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
 * AgentSession's beforeToolCall blocks before execute() is reached.
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

async function normalizeMockResult(
	handler: MockToolHandler,
	params: Record<string, unknown>,
): Promise<ToolResult> {
	let raw: string | ToolResult;

	if (typeof handler === "string") {
		raw = handler;
	} else if (typeof handler === "function") {
		raw = await handler(params);
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

/** Shared execution replacement for request tools and native nested tool definitions. */
export function createMockExecute(
	toolName: string,
	handler: MockToolHandler,
	state: PlaybookState,
	mockedIds: Set<string>,
): AgentTool["execute"] {
	return async (toolCallId, params) => {
		mockedIds.add(toolCallId);
		const result = await normalizeMockResult(handler, params as Record<string, unknown>);
		fireThenCallback(state, toolCallId, {
			step: state.consumed,
			toolName,
			toolCallId,
			text: result.content.filter(c => c.type === "text").map(c => c.text).join("\n"),
			content: result.content,
			isError: result.isError ?? false,
			details: result.details,
			structuredContent: result.structuredContent,
			mocked: true,
		});
		return { ...result, details: result.details ?? {} } as Awaited<ReturnType<AgentTool["execute"]>>;
	};
}

/** Wrap request-snapshot tools without replacing Pi's validation or hooks. */
export function interceptToolExecution(
	tools: AgentTool[],
	mockTools: Record<string, MockToolHandler>,
	playbookState: PlaybookState,
	propagateErrors: boolean,
	mockedIds: Set<string>,
): AgentTool[] {
	return tools.map(tool => {
		const handler = mockTools[tool.name];
		return handler === undefined
			? wrapForCollection(tool, playbookState, propagateErrors)
			: { ...tool, execute: createMockExecute(tool.name, handler, playbookState, mockedIds) };
	});
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
					structuredContent: result.structuredContent,
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
