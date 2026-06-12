import type { components } from "./registry-api.types.js";

export type McpRegistryPackage = components["schemas"]["Package"];
export type McpRegistryRemote = components["schemas"]["Transport"];

export type McpServerOrigin =
  | { kind: "raw" }
  | {
    kind: "registry";
    selected:
      | { kind: "package"; package: McpRegistryPackage }
      | { kind: "remote"; remote: McpRegistryRemote };
  };

export type McpServerInfo = {
  transport: "stdio";
  command: string;
  args: string[];
  origin: McpServerOrigin;
};

export type McpServerResolution = {
  force: boolean;
  server?: McpServerInfo;
};
