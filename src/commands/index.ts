import { Command } from "commander";
import { formatError } from "../config.js";
import type { AppServices } from "../services.js";
import { registerRegistryCommands } from "./registry.js";
import { registerServerCommands } from "./server.js";
import { registerToolCommands } from "./tool.js";

export class CommandRegistry {
  static async parseServer(services: AppServices, server: string[]) {
    return await services.resolveMcpServer(server);
  }

  static register(services: AppServices, program: Command) {
    registerServerCommands(program, services);
    registerRegistryCommands(program, services);
    registerToolCommands(program, services, (server) => CommandRegistry.parseServer(services, server));
  }

  static build(services: AppServices, options?: { interactive?: boolean }) {
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
