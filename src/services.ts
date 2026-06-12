import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createInterface, type Interface as ReadlineInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { parseArgsStringToArgv } from "string-argv";
import {
  DEFAULT_MCP_SERVER_CONFIG_FILE,
  formatError,
  loadSavedMcpServerInfo,
  parseMcpServerInfo,
  readMcpServerConfig,
  resolveMcpServerArgs,
  saveMcpServerInfo,
} from "./config.js";
import { buildToolExecProgram, type ToolOptionSpec } from "./commands/tool.js";
import { CommandRegistry } from "./commands/index.js";
import { AppSession } from "./session.js";
import type { McpServerInfo, McpServerResolution } from "./types.js";

export class AppServices {
  session: AppSession;
  private prompt?: ReadlineInterface;
  private configFile: string;

  constructor(session = new AppSession(), configFile = DEFAULT_MCP_SERVER_CONFIG_FILE) {
    this.session = session;
    this.configFile = configFile;
  }

  parseMcpServerInfo(serverArgs: string[]) {
    return parseMcpServerInfo(serverArgs);
  }

  async readMcpServerConfig() {
    return await readMcpServerConfig(this.configFile);
  }

  async loadSavedMcpServerInfo(name: string) {
    return await loadSavedMcpServerInfo(name, this.configFile);
  }

  async saveMcpServerInfo(name: string, info: McpServerInfo, overwrite: boolean) {
    await saveMcpServerInfo(name, info, this.configFile, overwrite);
    return info;
  }

  async saveNamedServer(name: string, serverArgs: string[], overwrite = false) {
    const info = this.parseMcpServerInfo(serverArgs);
    await this.saveMcpServerInfo(name, info, overwrite);
    return info;
  }

  async resolveMcpServer(args: string[]): Promise<McpServerResolution> {
    return await resolveMcpServerArgs(args, this.configFile);
  }

  async listSavedServers() {
    const config = await this.readMcpServerConfig();
    return Object.keys(config).sort();
  }

  async loadServer(server?: McpServerResolution) {
    await this.session.resolveClient(server);
  }

  async getTools(server?: McpServerResolution) {
    await this.loadServer(server);
    return this.session.getTools();
  }

  async callTool(name: string, args: Record<string, unknown>, server?: McpServerResolution) {
    return await this.session.withMcpClient(server, async ({ client }) => {
      return await client.callTool({ name, arguments: args });
    });
  }

  private isPromptingEnabled() {
    return this.session.type === "interactive" && this.prompt !== undefined;
  }

  private getPromptDefault(toolName: string, spec: ToolOptionSpec) {
    const cached = this.session.getToolInputValue(toolName, spec.propertyName);

    if (cached !== undefined) {
      return { value: cached, source: "previous" as const };
    }

    if (spec.schema.default !== undefined) {
      return { value: spec.schema.default, source: "schema" as const };
    }

    return undefined;
  }

  private parseBooleanPromptValue(value: string) {
    const normalized = value.trim().toLowerCase();

    if (normalized === "true" || normalized === "t" || normalized === "yes" || normalized === "y" || normalized === "1") {
      return true;
    }

    if (normalized === "false" || normalized === "f" || normalized === "no" || normalized === "n" || normalized === "0") {
      return false;
    }

    throw new Error(`Expected a boolean value like true/false, yes/no, or 1/0, received ${JSON.stringify(value)}`);
  }

  private async promptForToolValue(toolName: string, spec: ToolOptionSpec) {
    if (!this.prompt) {
      throw new Error(`Missing required argument "${spec.propertyName}". Provide it with --${spec.propertyName}.`);
    }

    const fallback = this.getPromptDefault(toolName, spec);
    const description = spec.schema.description ? ` ${spec.schema.description}` : "";
    const defaultLabel = fallback ? ` [default ${fallback.source}: ${spec.formatPromptDefault(fallback.value)}]` : "";
    const typeLabel = spec.schemaType ? ` (${spec.schemaType})` : "";

    while (true) {
      const answer = await this.prompt.question(`${toolName}.${spec.propertyName}${typeLabel}:${defaultLabel}${description} `);
      const trimmed = answer.trim();

      if (trimmed === "") {
        if (fallback) return fallback.value;
        if (spec.schemaType === "string" || spec.schemaType === undefined) return "";
        if (spec.schemaType === "boolean") return false;
      }

      try {
        if (spec.schemaType === "boolean") {
          return this.parseBooleanPromptValue(answer);
        }

        if (spec.parser) {
          return spec.parser(answer);
        }

        return answer;
      } catch (err) {
        console.error(`Failed: ${formatError(err)}`);
      }
    }
  }

  private async resolveToolArguments(tool: Tool, args: Record<string, unknown>, specs: ToolOptionSpec[]) {
    const resolvedArgs = { ...args };

    for (const spec of specs) {
      if (!spec.required) continue;
      if (resolvedArgs[spec.propertyName] !== undefined) continue;

      const promptable = spec.schemaType === "string"
        || spec.schemaType === "number"
        || spec.schemaType === "integer"
        || spec.schemaType === "boolean"
        || spec.schemaType === undefined;

      if (this.isPromptingEnabled() && promptable) {
        resolvedArgs[spec.propertyName] = await this.promptForToolValue(tool.name, spec);
        continue;
      }

      throw new Error(`Missing required argument "${spec.propertyName}" for tool "${tool.name}". Provide it with --${spec.propertyName}.`);
    }

    return resolvedArgs;
  }

  async executeTool(tool: Tool, args: Record<string, unknown>, specs: ToolOptionSpec[], server?: McpServerResolution) {
    await this.loadServer(server);
    const resolvedArgs = await this.resolveToolArguments(tool, args, specs);
    const result = await this.callTool(tool.name, resolvedArgs, server);
    this.session.rememberToolArguments(tool.name, resolvedArgs);
    return result;
  }

  async i(server?: McpServerResolution) {
    await this.loadServer(server);
    const rl = createInterface({ input, output });
    this.prompt = rl;
    const program = CommandRegistry.build(this, { interactive: true })
      .exitOverride()
      .configureOutput({
        writeErr: (str) => output.write(str),
        writeOut: (str) => output.write(str),
      });

    try {
      while (true) {
        let line: string;

        try {
          line = await rl.question("mcplane> ");
        } catch (err) {
          if (formatError(err) === "readline was closed") break;
          throw err;
        }

        const trimmed = line.trim();

        if (!trimmed) continue;
        if (trimmed === "exit" || trimmed === "quit") break;

        try {
          const argv = parseArgsStringToArgv(trimmed);
          await program.parseAsync(argv, { from: "user" });
        } catch (err: any) {
          if (err?.code === "commander.helpDisplayed") continue;
          if (err?.code === "commander.executeSubCommandAsync") continue;
          console.error(`Failed: ${formatError(err)}`);
        }
      }
    } finally {
      this.prompt = undefined;
      rl.close();
    }
  }
}
