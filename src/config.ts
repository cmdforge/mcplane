import { Command } from "commander";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { McpServerInfo, McpServerResolution } from "./types.js";

type McpServerResolverOptions = {
  force?: boolean;
  load?: string;
  save?: string;
};

type McpServerConfig = Record<string, string>;

export const DEFAULT_MCP_SERVER_CONFIG_FILE = resolve(".mcplane/config.json");

export function formatError(err: unknown) {
  if (err instanceof Error) return err.message;

  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function createMcpServerInfoCommand() {
  return new Command("mcp-server")
    .exitOverride()
    .passThroughOptions()
    .option("-f, --force", "Reconnect even if the target server matches the loaded one")
    .option("--load <name>", "Load a saved server from .mcplane/config.json")
    .option("--save <name>", "Save the resolved server to .mcplane/config.json")
    .argument("[server...]");
}

export function parseMcpServerInfo(serverArgs: string[]): McpServerInfo {
  const [transport, command, ...commandArgs] = serverArgs;

  if (!transport) throw new Error("Missing transport");
  if (!command) throw new Error("Missing MCP server command");
  if (transport !== "stdio") throw new Error(`transport ${transport} not implemented`);

  return {
    transport,
    command,
    args: commandArgs,
    origin: { kind: "raw" },
  };
}

export async function readMcpServerConfig(configFile: string): Promise<McpServerConfig> {
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

  return {
    transport: info.transport,
    command: info.command,
    args: info.args,
    origin: info.origin ?? { kind: "raw" },
  };
}

export async function loadSavedMcpServerInfo(name: string, configFile: string) {
  const config = await readMcpServerConfig(configFile);
  const serialized = config[name];

  if (!serialized) {
    throw new Error(`Saved server "${name}" was not found in ${configFile}`);
  }

  return parseSavedMcpServerInfo(name, serialized);
}

export async function saveMcpServerInfo(name: string, info: McpServerInfo, configFile: string, overwrite: boolean) {
  const config = await readMcpServerConfig(configFile);

  if (!overwrite && config[name] !== undefined) {
    throw new Error(`Saved server "${name}" already exists in ${configFile}. Use -f to overwrite it.`);
  }

  config[name] = JSON.stringify(info);
  await mkdir(dirname(configFile), { recursive: true });
  await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`);
}

export async function resolveMcpServerArgs(args: string[], configFile: string): Promise<McpServerResolution> {
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
    ? await loadSavedMcpServerInfo(options.load, configFile)
    : parseMcpServerInfo(serverArgs ?? []);

  if (options.save) {
    await saveMcpServerInfo(options.save, info, configFile, options.force ?? false);
  }

  return {
    force: options.force ?? false,
    server: info,
  };
}
