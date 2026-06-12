import { Command, Option } from "commander";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { stdout as output } from "node:process";
import { formatError } from "../config.js";
import type { AppServices } from "../services.js";

type SupportedToolInputSchema = {
  $schema?: string;
  type?: string | string[];
  properties?: Record<string, SupportedToolPropertySchema>;
  required?: string[];
  description?: string;
  title?: string;
  enum?: unknown[];
  default?: unknown;
  items?: SupportedToolPropertySchema;
  anyOf?: SupportedToolPropertySchema[];
  oneOf?: SupportedToolPropertySchema[];
};

type SupportedToolPropertySchema = SupportedToolInputSchema;

export type ToolOptionSpec = {
  propertyName: string;
  attributeName: string;
  schema: SupportedToolPropertySchema;
  schemaType?: string;
  required: boolean;
  parser?: (value: string, previous?: unknown) => unknown;
  isArray?: boolean;
  formatPromptDefault: (value: unknown) => string;
};

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

function readSchemaType(schema?: SupportedToolPropertySchema): string | undefined {
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
  return JSON.stringify(value);
}

function formatPromptDefault(value: unknown) {
  if (typeof value === "string") return value;
  return formatSchemaValue(value);
}

function describeSchemaProperty(propertyName: string, schema: SupportedToolPropertySchema, required: boolean) {
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

function createToolOptionSpec(propertyName: string, schema: SupportedToolPropertySchema, required: boolean): { option: Option, spec: ToolOptionSpec } {
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
      formatPromptDefault,
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

export function buildToolExecProgram(services: AppServices, tools: Tool[]) {
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
      const { option, spec } = createToolOptionSpec(propertyName, schema as SupportedToolPropertySchema, required.has(propertyName));
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

export function registerToolCommands(program: Command, services: AppServices, parseServer: (server: string[]) => Promise<import("../types.js").McpServerResolution>) {
  const tool = program.command("tool").description("Interact with the loaded MCP server tools");

  tool.command("schema")
    .argument("[server...]", "-- [server options] <transport> <command> [args...]")
    .allowUnknownOption()
    .action(async (server) => {
      try {
        const tools = await services.getTools(await parseServer(server));
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
        const tools = await services.getTools(await parseServer(server));
        console.log(buildToolExecProgram(services, tools).helpInformation());
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
        const server = await parseServer(serverArgs);
        await services.loadServer(server);
        const execProgram = buildToolExecProgram(services, services.session.getTools())
          .exitOverride()
          .configureOutput({
            writeErr: (str) => output.write(str),
            writeOut: (str) => output.write(str),
          });

        if (execArgs.length === 0) {
          console.log(execProgram.helpInformation());
          return;
        }

        await execProgram.parseAsync(execArgs, { from: "user" });
      } catch (err: any) {
        if (err?.code === "commander.helpDisplayed") return;
        if (err?.code === "commander.executeSubCommandAsync") return;
        console.error(`Failed: ${formatError(err)}`);
        process.exitCode = 1;
      }
    });
}
