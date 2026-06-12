import { Command, Option } from "commander";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface, type Interface as ReadlineInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { parseArgsStringToArgv } from "string-argv";

export type McpInfo = {
  transport: string;
  command: string;
  args: string[];
};

export type McpServerInfo = McpInfo;

export type McpServerResolution = {
  force: boolean;
  server?: McpServerInfo;
};

type McpServerResolverOptions = {
  force?: boolean;
  load?: string;
  save?: string;
};

type McpServerConfig = Record<string, string>;

type JsonSchemaObject = {
  $schema?: string;
  type?: string | string[];
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  description?: string;
  title?: string;
  enum?: unknown[];
  default?: unknown;
  items?: JsonSchemaProperty;
  anyOf?: JsonSchemaProperty[];
  oneOf?: JsonSchemaProperty[];
};

type JsonSchemaProperty = JsonSchemaObject;

type ToolOptionSpec = {
  propertyName: string;
  attributeName: string;
  schema: JsonSchemaProperty;
  schemaType?: string;
  required: boolean;
  parser?: (value: string, previous?: unknown) => unknown;
  isArray?: boolean;
};

type ToolInputCache = Record<string, Record<string, Record<string, unknown>>>;

export const DEFAULT_MCP_SERVER_CONFIG_FILE = resolve(".mcplane.json");

function resolveMcpTransport({ transport, command, args }: McpInfo) {
  switch (transport) {
    case "stdio":
      return new StdioClientTransport({ command, args });
    default: throw Error(`transport ${transport} not implemented`);
  }
}

function serializeMcpInfo(info: McpInfo) {
  return JSON.stringify(info);
}

function splitToolExecArgs(argv: string[]) {
  const separatorIndex = argv.indexOf("--");

  if (separatorIndex === -1) {
    return {
      execArgs: argv,
      serverArgs: [] as string[],
    };
  }

  return {
    execArgs: argv.slice(0, separatorIndex),
    serverArgs: argv.slice(separatorIndex + 1),
  };
}

function readSchemaType(schema?: JsonSchemaProperty): string | undefined {
  if (!schema) return undefined;

  if (typeof schema.type === "string") return schema.type;
  if (Array.isArray(schema.type)) {
    const preferred = schema.type.find((type) => type !== "null");
    if (preferred) return preferred;
  }

  for (const variant of schema.oneOf ?? schema.anyOf ?? []) {
    const type = readSchemaType(variant);
    if (type) return type;
  }

  if (schema.enum?.length) {
    const sample = schema.enum[0];
    if (typeof sample === "string") return "string";
    if (typeof sample === "number") return Number.isInteger(sample) ? "integer" : "number";
    if (typeof sample === "boolean") return "boolean";
  }

  return undefined;
}

function formatSchemaValue(value: unknown) {
  return typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value);
}

function formatPromptDefault(value: unknown) {
  if (typeof value === "string") return value;
  return formatSchemaValue(value);
}

function describeSchemaProperty(propertyName: string, schema: JsonSchemaProperty, required: boolean) {
  const fragments: string[] = [];
  const type = readSchemaType(schema);

  if (schema.description) fragments.push(schema.description);
  if (type) fragments.push(`type: ${type}`);
  if (required) fragments.push("required");

  if (schema.enum?.length) {
    fragments.push(`choices: ${schema.enum.map((value) => formatSchemaValue(value)).join(", ")}`);
  }

  if (schema.default !== undefined) {
    fragments.push(`default: ${formatSchemaValue(schema.default)}`);
  }

  if (!schema.description) {
    fragments.unshift(`Input for ${propertyName}`);
  }

  return fragments.join(" ");
}

function parseJsonValue(value: string) {
  try {
    return JSON.parse(value);
  } catch (err) {
    throw new Error(`Expected valid JSON. ${formatError(err)}`);
  }
}

function parseNumericValue(value: string, integer: boolean) {
  const numberValue = Number(value);

  if (!Number.isFinite(numberValue)) {
    throw new Error(`Expected a ${integer ? "integer" : "number"}, received ${JSON.stringify(value)}`);
  }

  if (integer && !Number.isInteger(numberValue)) {
    throw new Error(`Expected an integer, received ${JSON.stringify(value)}`);
  }

  return numberValue;
}

function collectOptionValue(value: unknown, previous?: unknown) {
  const items = Array.isArray(previous) ? previous : [];
  items.push(value);
  return items;
}

function createToolOptionSpec(propertyName: string, schema: JsonSchemaProperty, required: boolean): { option: Option, spec: ToolOptionSpec } {
  const schemaType = readSchemaType(schema);
  const isBoolean = schemaType === "boolean";
  const isArray = schemaType === "array";
  const itemType = isArray ? readSchemaType(schema.items) : undefined;
  const valueLabel = isArray
    ? `<${propertyName}-item>`
    : schemaType === "object"
      ? `<${propertyName}-json>`
      : `<${propertyName}>`;

  const option = new Option(
    isBoolean ? `--${propertyName}` : `--${propertyName} ${valueLabel}`,
    describeSchemaProperty(propertyName, schema, required)
  );

  if (required) {
    option.required = false;
  }

  if (schema.enum?.length && schema.enum.every((value) => typeof value === "string")) {
    option.choices(schema.enum as string[]);
  }

  let parser: ToolOptionSpec["parser"];

  switch (schemaType) {
    case "integer":
      parser = (value) => parseNumericValue(value, true);
      break;
    case "number":
      parser = (value) => parseNumericValue(value, false);
      break;
    case "object":
      parser = (value) => parseJsonValue(value);
      break;
    case "array":
      if (itemType === "integer") {
        parser = (value) => parseNumericValue(value, true);
      } else if (itemType === "number") {
        parser = (value) => parseNumericValue(value, false);
      } else if (itemType === "object" || itemType === "array") {
        parser = (value) => parseJsonValue(value);
      }
      break;
    default:
      break;
  }

  if (parser) {
    option.argParser(isArray ? (value, previous) => collectOptionValue(parser(value), previous) : parser);
  } else if (isArray) {
    option.argParser((value, previous) => collectOptionValue(value, previous));
  }

  const attributeName = option.attributeName();

  return {
    option,
    spec: {
      propertyName,
      attributeName,
      schema,
      schemaType,
      required,
      parser,
      isArray,
    }
  };
}

function collectToolArguments(options: Record<string, unknown>, specs: ToolOptionSpec[]) {
  const args: Record<string, unknown> = {};

  for (const spec of specs) {
    const value = options[spec.attributeName];

    if (value !== undefined) {
      args[spec.propertyName] = value;
    }
  }

  return args;
}

function buildToolExecProgram(services: AppServices, tools: Tool[]) {
  const program = new Command()
    .name("tool exec")
    .description("Execute a tool from the loaded MCP server")
    .showHelpAfterError();

  for (const tool of tools) {
    const command = program.command(tool.name)
      .description(tool.description ?? tool.title ?? tool.annotations?.title ?? tool.name);

    const required = new Set(tool.inputSchema.required ?? []);
    const specs: ToolOptionSpec[] = [];

    for (const [propertyName, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
      const { option, spec } = createToolOptionSpec(propertyName, schema, required.has(propertyName));
      specs.push(spec);
      command.addOption(option);
    }

    command.action(async (...actionArgs) => {
      const commandInstance = actionArgs.at(-1) as Command;
      const result = await services.executeTool(tool, collectToolArguments(commandInstance.opts(), specs), specs);
      console.log(JSON.stringify(result, null, 2));
    });
  }

  return program;
}

function createMcpServerInfoCommand() {
  return new Command("mcp-server")
    .exitOverride()
    .passThroughOptions()
    .option("-f, --force", "Reconnect even if the target server matches the loaded one")
    .option("--load <name>", "Load a saved server from .mcplane.json")
    .option("--save <name>", "Save the resolved server to .mcplane.json")
    .argument("[server...]");
}

function parseMcpServerInfo(serverArgs: string[]): McpServerInfo {
  const [transport, command, ...commandArgs] = serverArgs;

  if (!transport) throw new Error("Missing transport");
  if (!command) throw new Error("Missing MCP server command");

  const info: McpServerInfo = {
    transport,
    command,
    args: commandArgs
  };

  resolveMcpTransport(info);
  return info;
}

async function readMcpServerConfig(configFile: string): Promise<McpServerConfig> {
  try {
    const contents = await readFile(configFile, "utf8");
    const parsed = JSON.parse(contents);

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Expected ${configFile} to contain a JSON object`);
    }

    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => {
        if (typeof value !== "string") {
          throw new Error(`Expected saved server "${key}" in ${configFile} to be a string`);
        }

        return [key, value];
      })
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

export function formatError(err: unknown) {
  if (err instanceof Error) return err.message;

  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function parseSavedMcpServerInfo(name: string, serialized: string): McpServerInfo {
  let parsed: unknown;

  try {
    parsed = JSON.parse(serialized);
  } catch (err) {
    throw new Error(`Saved server "${name}" is not valid JSON. ${formatError(err)}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Saved server "${name}" must be a JSON object`);
  }

  const info = parsed as Partial<McpServerInfo & { force?: unknown }>;

  if (typeof info.transport !== "string") {
    throw new Error(`Saved server "${name}" is missing a string "transport"`);
  }

  if (typeof info.command !== "string") {
    throw new Error(`Saved server "${name}" is missing a string "command"`);
  }

  if (!Array.isArray(info.args) || info.args.some((arg) => typeof arg !== "string")) {
    throw new Error(`Saved server "${name}" is missing a string[] "args"`);
  }

  return parseMcpServerInfo([info.transport, info.command, ...info.args]);
}

async function loadSavedMcpServerInfo(name: string, configFile: string) {
  const config = await readMcpServerConfig(configFile);
  const serialized = config[name];

  if (!serialized) {
    throw new Error(`Saved server "${name}" was not found in ${configFile}`);
  }

  return parseSavedMcpServerInfo(name, serialized);
}

async function saveMcpServerInfo(name: string, info: McpServerInfo, configFile: string, overwrite: boolean) {
  const config = await readMcpServerConfig(configFile);

  if (!overwrite && config[name] !== undefined) {
    throw new Error(`Saved server "${name}" already exists in ${configFile}. Use -f to overwrite it.`);
  }

  config[name] = JSON.stringify(info);
  await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`);
}

export async function resolveMcpServer(args: string[], configFile = DEFAULT_MCP_SERVER_CONFIG_FILE): Promise<McpServerResolution> {
  return await new AppServices(new AppSession("oneshot", false), configFile).resolveMcpServer(args);
}

type AppSessionType = "oneshot" | "interactive";

export class AppSession {
  private sessionType: AppSessionType;
  private info?: McpInfo;
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

  private async connect(info: McpInfo) {
    const transport = resolveMcpTransport(info);
    const nextClient = new Client({
      name: `mcplane: ${serializeMcpInfo(info)}`,
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

    if (!server.force && this.info && serializeMcpInfo(this.info) === serializeMcpInfo(nextInfo)) {
      if (!this.client) throw Error("Cannot proceed without an MCP server");
      return { info: this.info, client: this.client };
    }

    await this.connect(nextInfo);
    if (!this.info) throw Error("Cannot proceed without MCP server info");
    if (!this.client) throw Error("Cannot proceed without an MCP server");
    return { info: this.info, client: this.client };
  }

  async withMcpClient<T = void>(server: McpServerResolution | undefined, action: (_: { info: McpInfo, client: Client }) => Promise<T>) {
    const { info, client } = await this.resolveClient(server);
    return await action({ info, client });
  }

  getTools() {
    return this.tools;
  }

  getToolInputValue(toolName: string, propertyName: string) {
    if (!this.info) return undefined;
    return this.toolInputCache[serializeMcpInfo(this.info)]?.[toolName]?.[propertyName];
  }

  rememberToolArguments(toolName: string, args: Record<string, unknown>) {
    if (!this.info) return;

    const serverKey = serializeMcpInfo(this.info);
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
    if (args.length === 0) return { force: false };

    const parser = createMcpServerInfoCommand();

    try {
      await parser.parseAsync(args, { from: "user" });
    } catch (err) {
      throw new Error(
        "Invalid server arguments. Pass them after \"--\" as [server options] <transport> <command> [args...]. "
        + formatError(err)
      );
    }

    const options = parser.opts<McpServerResolverOptions>();
    const serverArgs = parser.processedArgs[0] as string[] | undefined;
    const info = options.load
      ? await this.loadSavedMcpServerInfo(options.load)
      : this.parseMcpServerInfo(serverArgs ?? []);

    if (options.save) {
      await this.saveMcpServerInfo(options.save, info, options.force ?? false);
    }

    return {
      force: options.force ?? false,
      server: info,
    };
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
    const defaultLabel = fallback ? ` [default ${fallback.source}: ${formatPromptDefault(fallback.value)}]` : "";
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

  async showToolExecHelp(server?: McpServerResolution) {
    const tools = await this.getTools(server);
    return buildToolExecProgram(this, tools).helpInformation();
  }

  async execTool(argv: string[], server?: McpServerResolution) {
    await this.loadServer(server);

    const program = buildToolExecProgram(this, this.session.getTools())
      .exitOverride()
      .configureOutput({
        writeErr: (str) => output.write(str),
        writeOut: (str) => output.write(str),
      });

    if (argv.length === 0) {
      console.log(program.helpInformation());
      return;
    }

    await program.parseAsync(argv, { from: "user" });
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

export class CommandRegistry {
  static async parseServer(services: AppServices, server: string[]) {
    return await services.resolveMcpServer(server);
  }

  static register(services: AppServices, program: Command) {
    const server = program.command("server").description("Manage saved MCP server definitions");

    server.command("list")
      .description("List saved MCP server names")
      .action(async () => {
        try {
          console.log(JSON.stringify(await services.listSavedServers(), null, 2));
        } catch (err) {
          console.error(`Failed: ${formatError(err)}`);
          process.exitCode = 1;
        }
      });

    server.command("load")
      .description("Load a saved MCP server definition")
      .argument("<name>", "Saved server name")
      .action(async (name) => {
        try {
          console.log(JSON.stringify(await services.loadSavedMcpServerInfo(name), null, 2));
        } catch (err) {
          console.error(`Failed: ${formatError(err)}`);
          process.exitCode = 1;
        }
      });

    server.command("save")
      .description("Save an MCP server definition")
      .option("-f, --force", "Overwrite an existing saved server")
      .argument("<name>", "Saved server name")
      .argument("[server...]", "-- <transport> <command> [args...]")
      .allowUnknownOption()
      .action(async (name, serverArgs: string[] = [], options: { force?: boolean }) => {
        try {
          console.log(JSON.stringify(await services.saveNamedServer(name, serverArgs, options.force ?? false), null, 2));
        } catch (err) {
          console.error(`Failed: ${formatError(err)}`);
          process.exitCode = 1;
        }
      });

    const tool = program.command("tool").description("Interact with the loaded MCP server tools");

    tool.command("schema")
      .argument("[server...]", "-- [server options] <transport> <command> [args...]")
      .allowUnknownOption()
      .action(async (server) => {
        try {
          const tools = await services.getTools(await CommandRegistry.parseServer(services, server));
          console.log(JSON.stringify(tools, null, 2));
        } catch (err) {
          console.error(`Failed: ${formatError(err)}`);
          process.exitCode = 1;
        }
      });

    tool.command("list")
      .argument("[server...]", "-- [server options] <transport> <command> [args...]")
      .allowUnknownOption()
      .action(async (server) => {
        try {
          console.log(await services.showToolExecHelp(await CommandRegistry.parseServer(services, server)));
        } catch (err) {
          console.error(`Failed: ${formatError(err)}`);
          process.exitCode = 1;
        }
      });

    tool.command("exec")
      .argument("[argv...]", "[tool args...] -- [server options] <transport> <command> [args...]")
      .allowUnknownOption()
      .action(async (argv: string[] = []) => {
        try {
          const { execArgs, serverArgs } = splitToolExecArgs(argv);
          await services.execTool(execArgs, await CommandRegistry.parseServer(services, serverArgs));
        } catch (err: any) {
          if (err?.code === "commander.helpDisplayed") return;
          if (err?.code === "commander.executeSubCommandAsync") return;
          console.error(`Failed: ${formatError(err)}`);
          process.exitCode = 1;
        }
      });
  }

  static build(services: AppServices = new AppServices(), options?: { interactive?: boolean }) {
    const program = new Command("mcplane")
      .showHelpAfterError();

    if (!options?.interactive) {
      program.command("i")
        .description("Enter an interactive session")
        .argument("[server...]", "-- [server options] <transport> <command> [args...]")
        .allowUnknownOption()
        .action(async (server) => {
          try {
            await services.i(await CommandRegistry.parseServer(services, server));
          } catch (err) {
            console.error(`Failed: ${formatError(err)}`);
            process.exitCode = 1;
          } finally {
            await services.session.dispose();
          }
        });
    }

    CommandRegistry.register(services, program);
    return program;
  }
}

export async function main() {
  const services = new AppServices();

  try {
    await CommandRegistry.build(services).parseAsync();
  } finally {
    if (services.session.type !== "interactive") {
      await services.session.dispose();
    }
  }
}
