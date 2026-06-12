import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { formatError } from "./config.js";
import type { McpServerInfo, McpServerResolution } from "./types.js";

type ToolInputCache = Record<string, Record<string, Record<string, unknown>>>;
type AppSessionType = "oneshot" | "interactive";

function resolveMcpTransport({ transport, command, args }: McpServerInfo) {
  switch (transport) {
    case "stdio":
      return new StdioClientTransport({ command, args });
    default: throw Error(`transport ${transport} not implemented`);
  }
}

export function serializeMcpServerInfo(info: McpServerInfo) {
  return JSON.stringify(info);
}

export class AppSession {
  private sessionType: AppSessionType;
  private info?: McpServerInfo;
  private client?: Client;
  private tools: Tool[] = [];
  private toolInputCache: ToolInputCache = {};
  private disposed = false;

  get type() { return this.sessionType; }

  constructor(sessionType: AppSessionType = "oneshot", installProcessHandlers = true) {
    this.sessionType = sessionType;
    if (installProcessHandlers) {
      process.once("SIGINT", () => this.forceExit(130));
      process.once("SIGTERM", () => this.forceExit(143));
      process.once("uncaughtException", (err) => this.forceExit(1, err));
      process.once("unhandledRejection", (err) => this.forceExit(1, err));
    }
  }

  private async closeClient() {
    if (this.client) {
      await this.client.close();
      this.info = undefined;
      this.client = undefined;
      this.tools = [];
      this.toolInputCache = {};
    }
  }

  private async connect(info: McpServerInfo) {
    const transport = resolveMcpTransport(info);
    const nextClient = new Client({
      name: `mcplane: ${serializeMcpServerInfo(info)}`,
      version: "0.0.0",
    }, {
      listChanged: {
        tools: {
          onChanged: (error, tools) => {
            if (error) {
              console.error(`Failed: ${formatError(error)}`);
              return;
            }

            if (tools) {
              this.tools = tools;
            }
          }
        }
      }
    });

    await nextClient.connect(transport);
    const { tools } = await nextClient.listTools();

    const prevClient = this.client;
    this.info = info;
    this.client = nextClient;
    this.tools = tools;

    if (prevClient) await prevClient.close();
  }

  async resolveClient(server: McpServerResolution = { force: false }) {
    if (!server.server) {
      if (!this.info) throw Error("Cannot proceed without MCP server info");
      if (!this.client) throw Error("Cannot proceed without an MCP server");
      return { info: this.info, client: this.client };
    }

    const nextInfo = server.server;

    if (!server.force && this.info && serializeMcpServerInfo(this.info) === serializeMcpServerInfo(nextInfo)) {
      if (!this.client) throw Error("Cannot proceed without an MCP server");
      return { info: this.info, client: this.client };
    }

    await this.connect(nextInfo);
    if (!this.info) throw Error("Cannot proceed without MCP server info");
    if (!this.client) throw Error("Cannot proceed without an MCP server");
    return { info: this.info, client: this.client };
  }

  async withMcpClient<T = void>(server: McpServerResolution | undefined, action: (_: { info: McpServerInfo, client: Client }) => Promise<T>) {
    const { info, client } = await this.resolveClient(server);
    return await action({ info, client });
  }

  getTools() {
    return this.tools;
  }

  getToolInputValue(toolName: string, propertyName: string) {
    if (!this.info) return undefined;
    return this.toolInputCache[serializeMcpServerInfo(this.info)]?.[toolName]?.[propertyName];
  }

  rememberToolArguments(toolName: string, args: Record<string, unknown>) {
    if (!this.info) return;

    const serverKey = serializeMcpServerInfo(this.info);
    const toolCache = this.toolInputCache[serverKey] ??= {};
    const toolArgs = toolCache[toolName] ??= {};

    for (const [propertyName, value] of Object.entries(args)) {
      toolArgs[propertyName] = value;
    }
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    await this.closeClient();
  }

  private forceExit(code: number, err?: any) {
    if (err) console.error(formatError(err));
    this.dispose()
      .catch(console.error)
      .finally(() => process.exit(code));
  }
}
