import { join } from "node:path";
import type { McpExtensionOptions, McpExposure } from "@earendil-works/pi-coding-agent";
import {
	isJsonRpcRequest, JSON_RPC_ERROR_CODES, LATEST_PROTOCOL_VERSION,
	SUPPORTED_PROTOCOL_VERSIONS,
	type CallToolResult, type JsonRpcErrorObject, type JsonRpcId,
	type JsonRpcRequest, type Tool,
} from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair, type InMemoryTransport } from "@earendil-works/pi-mcp/testing";

export type McpFixtureResponse = CallToolResult | { error: JsonRpcErrorObject };

export interface McpFixtureTool {
	tool: Tool;
	response: McpFixtureResponse | ((args: Record<string, unknown>) => McpFixtureResponse | Promise<McpFixtureResponse>);
}

export interface McpFixtureOptions {
	name?: string;
	exposure?: McpExposure;
	toolExposure?: Record<string, McpExposure>;
	tools: McpFixtureTool[];
}

export interface McpFixtureCall {
	requestId: JsonRpcId;
	toolName: string;
	arguments: Record<string, unknown>;
}

export interface McpFixture {
	/** Fresh options for each explicit createMcpExtension() composition. */
	readonly extensionOptions: McpExtensionOptions;
	/** Calls actually received by the external MCP peer, in receipt order. */
	readonly calls: McpFixtureCall[];
	/** True when no fixture transport remains open, including before connection. */
	readonly closed: boolean;
}

/** A controlled external MCP peer. Pi still owns the client, schemas and tool pipeline. */
export function createMcpFixture(options: McpFixtureOptions): McpFixture {
	const name = options.name ?? "fixture";
	const tools = new Map<string, McpFixtureTool>();
	for (const entry of options.tools) {
		if (tools.has(entry.tool.name)) throw new Error(`Duplicate MCP fixture tool: ${entry.tool.name}`);
		tools.set(entry.tool.name, entry);
	}
	const calls: McpFixtureCall[] = [];
	const open = new Set<InMemoryTransport>();

	async function respond(request: JsonRpcRequest): Promise<unknown> {
		switch (request.method) {
			case "initialize": {
				const requested = (request.params as { protocolVersion?: string } | undefined)?.protocolVersion;
				return {
					protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.find(v => v === requested) ?? LATEST_PROTOCOL_VERSION,
					capabilities: { tools: {} }, serverInfo: { name, version: "1.0.0" },
				};
			}
			case "tools/list": return { tools: [...tools.values()].map(entry => entry.tool) };
			case "tools/call": {
				const params = request.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
				const toolName = params?.name ?? "";
				const args = params?.arguments ?? {};
				calls.push({ requestId: request.id, toolName, arguments: structuredClone(args) });
				const entry = tools.get(toolName);
				if (!entry) return { error: { code: JSON_RPC_ERROR_CODES.invalidParams, message: `Unknown MCP fixture tool: ${toolName}` } };
				return typeof entry.response === "function" ? await entry.response(args) : entry.response;
			}
			default: return { error: { code: JSON_RPC_ERROR_CODES.methodNotFound, message: `Unsupported MCP fixture method: ${request.method}` } };
		}
	}

	return {
		calls,
		get closed() { return open.size === 0; },
		get extensionOptions() {
			const extensionOptions: McpExtensionOptions = {
				loadConfig(ctx) {
					extensionOptions.logPath = join(ctx.cwd, "mcp-fixture.log");
					return { errors: [], servers: [{ name, source: `in-memory:${name}`, scope: "extension", config: {
						command: "pi-test-harness-in-memory", exposure: options.exposure ?? "codemode", toolExposure: options.toolExposure,
					} }] };
				},
				createTransport(entry) {
					if (entry.name !== name) throw new Error(`Unexpected MCP fixture server: ${entry.name}`);
					const { client, server } = createInMemoryTransportPair();
					open.add(server);
					server.onClose(() => open.delete(server));
					server.onMessage(message => {
						if (!isJsonRpcRequest(message)) return;
						void (async () => {
							let response: unknown;
							try { response = await respond(message); }
							catch (error) { response = { error: { code: JSON_RPC_ERROR_CODES.internalError, message: error instanceof Error ? error.message : String(error) } }; }
							if (!open.has(server)) return;
							await server.send({ jsonrpc: "2.0", id: message.id, ...(
								response && typeof response === "object" && "error" in response
									? { error: response.error as JsonRpcErrorObject } : { result: response }
							) });
						})().catch(error => { client.emitError(error); void server.close(); });
					});
					void server.start();
					return client;
				},
			};
			return extensionOptions;
		},
	};
}
