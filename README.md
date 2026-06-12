# mcplane

`mcplane` turns a single MCP server into a CLI surface you can use either as a one-shot command target or as a long-lived interactive session.

The current project focus is simple:

- connect to exactly one MCP server at a time
- treat the server's tools like CLI functionality
- support one-shot usage for scripts and pipes
- support an interactive shell that can keep a server loaded between commands
- make server definitions easy to save and reload locally

## Status

This repository is an early standalone extraction of the project. The current implementation exposes:

- `tool schema`
- `tool list`
- `tool exec`
- `server list`
- `server load`
- `server save`
- `i` for interactive mode

Only `stdio` transport is currently implemented.

## Install

```bash
npm install
npm run build
```

For local development:

```bash
npm run dev -- tool list -- stdio node your-server.js
npm test
```

## Core idea

An MCP server already describes tools and how to call them. `mcplane` is aimed at making that feel more like a normal CLI:

- one-shot: connect, do a thing, exit
- interactive: connect once, then issue multiple commands against the same server

Example one-shot shape:

```bash
mcplane tool list -- stdio npx -y @modelcontextprotocol/server-memory
```

Example interactive shape:

```bash
mcplane i -- stdio npx -y @modelcontextprotocol/server-memory
```

Once interactive mode is running, you can issue supported commands inside the prompt:

```text
mcplane> tool list
mcplane> tool exec some-tool --message hello
```

## Tool commands

`mcplane` keeps a local in-session tool cache for the currently loaded server. On connect it immediately calls `tools/list`, and if the server advertises tool list change notifications, the cache refreshes automatically.

Current tool commands:

- `tool schema`
  Prints the cached MCP tool definitions as JSON.
- `tool list`
  Prints help for the generated `tool exec` command tree built from the cached tools.
- `tool exec`
  Invokes a separate generated Commander program named `tool exec`, with one subcommand per MCP tool.

Example:

```bash
mcplane tool exec some-tool --arg value -- stdio node server.js
```

### REPL prompting for missing required inputs

In interactive mode only, `tool exec` can prompt for missing required scalar inputs instead of failing immediately.

Current prompting behavior:

- REPL-only
- required inputs only
- scalar-first: `string`, `number`, `integer`, `boolean`
- previous session value is preferred when available
- otherwise schema default is used when available
- otherwise blank string or `false` is used for the basic fallback cases

This prompting is session-local only and is not persisted to disk.

## Server commands

Saved servers live in `.mcplane/config.json` in the current working directory.

Current commands:

- `server list`
  Prints the saved server names.
- `server load <name>`
  Prints the saved server definition as JSON.
- `server save <name> -- <transport> <command> [args...]`
  Saves a named server definition.

Examples:

```bash
mcplane server save demo -- stdio node server.js
mcplane server save -f demo -- stdio node other-server.js
mcplane server list
mcplane server load demo
```

## Server argument model

Anything to the right of the CLI-level `--` is treated as a server specification when a command targets an MCP server directly.

Current supported format:

```text
[server options] <transport> <command> [args...]
```

Current server options:

- `-f`, `--force`
- `--save <name>`
- `--load <name>`

Examples:

```bash
mcplane tool schema -- stdio node server.js
mcplane tool list -- --save demo stdio node server.js
mcplane tool exec some-tool --message hi -- --load demo
mcplane tool list -- -f --load demo
```

### `--load`

`--load <name>` is a convenience form that resolves through the same save/load functionality exposed under `server load`.

Semantics:

- if loading fails, the command fails
- it must not silently run against some previously loaded server by accident
- when `--load` is present, the loaded server is the target server

### `--save`

`--save <name>` is a convenience form that resolves through the same save/load functionality exposed under `server save`.

Semantics:

- saves the resolved server definition in `.mcplane/config.json`
- the saved value is the serialized `McpServerInfo`
- saving an existing name fails by default
- `-f --save <name>` overwrites an existing entry

### `-f` / `--force`

`force` is runtime behavior, not persisted server data.

Right now it is used for two related behaviors:

- force reconnection even if the requested server matches the currently loaded one
- allow overwriting a saved server entry when used with `--save`

## Config file

Saved servers live in `.mcplane/config.json` in the current working directory.

Example shape:

```json
{
  "demo": "{\"transport\":\"stdio\",\"command\":\"node\",\"args\":[\"server.js\"]}"
}
```

The project deliberately does not write to any existing MCP config format yet. It uses its own local file to avoid colliding with user-managed server definitions elsewhere.

## Development

Scripts:

```bash
npm run dev
npm run build
npm test
```

Tests use Node's built-in test runner with `tsx`:

```bash
node --test --import tsx src/**/*.test.ts
```

## Architecture

- `src/cli.ts`: tiny executable entrypoint
- `src/app.ts`: main application logic, command wiring, server resolution, config helpers, session handling, and generated tool CLI behavior
- `src/app.test.ts`: focused tests around server resolution, config behavior, and server command wiring

Important internal ideas:

- `AppServices` owns user-facing functionality and server/config operations
- `AppSession` owns the currently loaded MCP connection, tool cache, and interactive input cache
- `resolveMcpServer()` remains as a compatibility wrapper around service-backed resolution
- `McpServerInfo` is persisted server data
- `McpServerResolution` is transient runtime resolution data

## Current limitations

- only `stdio` transport is implemented
- generated tool execution currently lowers only a practical subset of JSON Schema into CLI flags
- REPL prompting currently focuses on missing required scalar fields
- there is not yet completions, shell integration, or richer output modes

## Direction

The likely long-term value of `mcplane` is that any MCP server could start to feel like a normal CLI surface.

That probably grows into things like:

- broader schema-to-CLI lowering
- richer interactive prompting and eventually UI-driven elicitation
- better transport support
- scripting-friendly output modes
- deeper shell ergonomics and completions

For the fuller project snapshot and implementation notes, see [`SPEC.md`](./SPEC.md).
