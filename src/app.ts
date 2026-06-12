import { DEFAULT_MCP_SERVER_CONFIG_FILE } from "./config.js";
import { CommandRegistry } from "./commands/index.js";
import { AppServices } from "./services.js";
import { AppSession } from "./session.js";

export { CommandRegistry } from "./commands/index.js";
export { DEFAULT_MCP_SERVER_CONFIG_FILE, formatError } from "./config.js";
export { AppServices } from "./services.js";
export { AppSession } from "./session.js";
export type { McpServerInfo, McpServerResolution } from "./types.js";

export async function resolveMcpServer(args: string[], configFile = DEFAULT_MCP_SERVER_CONFIG_FILE) {
  return await new AppServices(new AppSession("oneshot", false), configFile).resolveMcpServer(args);
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
