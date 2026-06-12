# mcplane Spec Snapshot

This file is a project-memory snapshot for future threads. It mixes current implemented behavior, design intent, and near-term direction.

## Project summary

`mcplane` is a CLI wrapper around MCP servers with a deliberately narrow mental model:

- pick one target MCP server
- connect to exactly one at a time
- expose that server through a CLI-friendly surface
- support both one-shot commands and an interactive shell

The framing is intentionally not "manage many servers at once".

## Product intent

The bigger idea is to make MCP servers feel like command-line tools.

Desired feel:

```bash
mcplane tool list -- stdio npx -y @modelcontextprotocol/server-memory
mcplane tool exec some-tool --message hi -- stdio npx -y @modelcontextprotocol/server-memory
```

or:

```bash
mcplane i -- stdio npx -y @modelcontextprotocol/server-memory
```

Then inside the interactive prompt:

```text
mcplane> tool list
mcplane> tool exec some-tool
```

The long-term idea is that any MCP server could start to feel like a native CLI surface.

## Current implementation status

Repository structure:

- `src/cli.ts`: executable entrypoint only; imports `main()` from `src/app.ts`
- `src/app.ts`: main implementation
- `src/app.test.ts`: focused tests

Implemented user-visible commands:

- `tool schema`
- `tool list`
- `tool exec`
- `server list`
- `server load`
- `server save`
- `i`

Implemented transport(s):

- `stdio` only

Implemented notable behavior:

- single-target session reuse with force reconnect support
- saved server config in `.mcplane/config.json`
- local tool cache populated immediately after connect
- tool list changed listener when the server advertises it
- generated Commander tree for `tool exec`
- basic REPL-only prompting for missing required scalar tool inputs

Not yet implemented:

- additional transports
- broad JSON Schema lowering coverage
- shell completions and shell integration
- richer output modes
- UI-driven elicitation

## Core design rules

### One server at a time

The session model is single-target.

- only one MCP server is connected at a time
- commands should never quietly run against an older loaded server when the user intended a different one
- if a command specifies a server target, that target must resolve and connect or the command should fail

### `--` introduces the server side

Anything after the CLI-level `--` is interpreted as a server specification area.

Current format:

```text
[server options] <transport> <command> [args...]
```

This keeps the server launch side simple and constrained.

### Server-side options only before the first non-option token

This was an intentional refinement.

Server-side options are parsed only before the first non-dash token after `--`. After that point the rest is treated as server launch data, not more `mcplane` flags.

That is why the implementation uses a dedicated Commander parser with `passThroughOptions()`.

### `AppServices` vs `AppSession`

This separation is important.

- `AppServices` owns user-facing functionality, config reads/writes, and resolution logic
- `AppSession` owns current client/session state, tool cache, and session-local interactive input cache

The CLI should mostly be wiring into services rather than carrying behavior itself.

### `force` is not persisted server data

`force` belongs to runtime behavior, not saved server definitions.

Current intended model:

- `McpServerInfo`: persisted target server data only
- `McpServerResolution`: transient runtime/request state

## Current types

### `McpServerInfo`

Current shape:

- `transport: "stdio"`
- `command: string`
- `args: string[]`

This is the persisted normalized server definition and the current runtime connection shape. It is what gets serialized into config and should not contain transient flags like `force`.

### `McpServerResolution`

Current shape:

- `force: boolean`
- `server?: McpServerInfo`

This represents:

- what server the user is targeting, if any
- whether runtime behavior should force reconnect / overwrite

## Server config behavior

Current config file:

- `.mcplane/config.json`

Reason for the custom name:

- avoid interfering with any user-managed existing MCP server configs
- avoid pretending there is a standard persisted MCP config format the project already wants to adopt

Current file shape:

```json
{
  "demo": "{\"transport\":\"stdio\",\"command\":\"node\",\"args\":[\"server.js\"]}"
}
```

Important detail:

- values are serialized JSON strings of `McpServerInfo`, not nested JSON objects

Compatibility behavior:

- loading tolerates legacy saved objects that may still contain `force`
- new saves should not persist `force`

## Current server resolution flow

Main compatibility function:

- `resolveMcpServer(args: string[], configFile?: string): Promise<McpServerResolution>`

Important note:

- this is now a thin compatibility wrapper
- the real behavior lives in `AppServices.resolveMcpServer()`

Responsibilities of the service-backed flow:

- parse server-side options via a dedicated Commander parser
- resolve raw server args into `McpServerInfo`
- load saved server definitions through service methods
- save server definitions through service methods
- return a runtime `McpServerResolution`

### Server-side options currently supported

- `-f`, `--force`
- `--load <name>`
- `--save <name>`

### `--load`

Semantics:

- `--load` must load the target server
- if load fails, command must bail
- it must not silently fall back to a previously loaded or still loaded server
- when `--load` is present, the loaded target is the target server

The convenience flag resolves through the same functionality exposed by `server load`.

### `--save`

Semantics:

- `--save <name>` stores the resolved `McpServerInfo` in `.mcplane/config.json`
- saved value is literally the serialized `McpServerInfo`
- without `-f`, saving over an existing name fails
- with `-f`, overwrite is allowed

The convenience flag resolves through the same functionality exposed by `server save`.

### `-f`

Current meanings:

- force overwrite of an existing saved server entry
- force reconnect even if the requested server matches the already loaded server

This coupling may eventually deserve cleanup, but it still works for the project’s current scale.

## Server command tree

Current explicit server commands:

- `server list`
- `server load <name>`
- `server save <name> -- <transport> <command> [args...]`

Intent:

- these are the "full version" config-management commands
- `--load` and `--save` are just convenience forms for command flows that also need to target a server immediately

Current output behavior:

- `server list` prints the saved names as JSON
- `server load` prints the saved `McpServerInfo` as JSON
- `server save` saves and then prints the saved `McpServerInfo` as JSON

## Session behavior

Class:

- `AppSession`

Responsibilities:

- hold current `info?: McpServerInfo`
- hold current `client?: Client`
- connect new clients
- reuse current connection when appropriate
- keep a local `tools: Tool[]` cache for the loaded server
- keep a session-local cache of previously entered tool argument values
- dispose the active client cleanly

Current reconnect semantics:

- if no target server is supplied, the current loaded client must already exist
- if a target server is supplied and matches the currently loaded one, the existing client is reused unless `force` is true
- otherwise the old client is replaced with a newly connected one

## Tool cache behavior

On connect:

- a new MCP client is created
- a tool list changed listener is attached through the SDK client options
- `listTools()` is called immediately after connect
- the returned tools become the current session-local tool cache

If the server later emits a tool list changed notification and advertises the capability:

- the SDK auto-refreshes the list
- the session cache is updated from the listener callback

This means `tool schema`, `tool list`, and `tool exec` work from the local cache rather than fetching tools fresh on every command.

## Tool command tree

The handwritten top-level command namespace is stable:

- `tool schema`
- `tool list`
- `tool exec`

### `tool schema`

- serializes the current cached tool array as JSON

### `tool list`

- prints help text for a generated Commander program whose name is `tool exec`
- this is the human-facing browse surface for the loaded tool tree

### `tool exec`

- is a gateway into a separate generated Commander program
- the generated program is not flattened into the top-level CLI
- one generated subcommand is created per MCP tool

This separation is intentional because it keeps the handwritten CLI stable while allowing dynamic tool surfaces behind it.

## Current schema-to-CLI lowering

Each tool’s input schema is inspected and lowered into Commander options on a best-effort basis.

Currently supported/helpful behavior includes:

- command description from tool description/title metadata
- option descriptions from JSON Schema descriptions
- required markers reflected in help text
- string enum choices
- number and integer parsing
- JSON parsing for object-valued inputs
- repeated flags for arrays

Important current constraint:

- this is not a full JSON Schema compiler yet
- the goal right now is "predictable and useful", not exhaustive fidelity

## Interactive prompting behavior

There is now a very small first-pass elicitation layer for `tool exec`.

Current rules:

- REPL mode only
- required inputs only
- promptable types are currently scalar-first:
  - `string`
  - `number`
  - `integer`
  - `boolean`
  - unknown/untyped scalar-ish cases
- one-shot mode still fails on missing required args

Prompt fallback order:

1. previous value used for that tool and argument in the current loaded server session
2. JSON Schema default
3. a very basic empty fallback in a couple of primitive cases

The cache is intentionally session-local only and not written to disk.

## Current tests

Current tests focus on:

- raw server resolution
- save/load config semantics
- overwrite behavior
- missing saved server errors
- service-backed save/load/list behavior
- server command wiring for `server save` and `server load`

The test suite is still intentionally compact, but it now covers both the convenience resolution path and the explicit server command tree.

## Direction

The strongest version of `mcplane` still seems to be:

- not a general MCP manager
- not a many-server orchestration layer
- but a sharp tool that makes one MCP server feel native in a terminal

Likely next value areas:

- broader schema lowering coverage
- richer interactive prompting, especially for arrays/objects
- more transports
- better output modes for scripting
- completions and shell ergonomics
- eventual UI-driven session flows
