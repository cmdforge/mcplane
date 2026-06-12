import { formatError } from "../config.js";
import type { AppServices } from "../services.js";
import type { Command } from "commander";

export function registerServerCommands(program: Command, services: AppServices) {
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
}
