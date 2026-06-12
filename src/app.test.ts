import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AppServices, AppSession, CommandRegistry, resolveMcpServer } from "./app.js";

async function withTempConfig(run: (configFile: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "mcplane-test-"));
  const configFile = join(dir, ".mcplane.json");

  try {
    await run(configFile);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function captureConsole(run: () => Promise<void>) {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args) => {
    logs.push(args.map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" "));
  };

  console.error = (...args) => {
    errors.push(args.map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" "));
  };

  try {
    await run();
    return { logs, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test("resolves a raw stdio server definition", async () => {
  const resolution = await resolveMcpServer(["stdio", "node", "-e", "console.log(1)"]);

  assert.deepEqual(resolution, {
    force: false,
    server: {
      transport: "stdio",
      command: "node",
      args: ["-e", "console.log(1)"],
    },
  });
});

test("saves a named server without persisting force", async () => {
  await withTempConfig(async (configFile) => {
    const resolution = await resolveMcpServer(
      ["-f", "--save", "demo", "stdio", "node", "-e", "console.log(1)"],
      configFile
    );

    assert.equal(resolution.force, true);

    const contents = await readFile(configFile, "utf8");
    assert.match(contents, /"demo":/);
    assert.doesNotMatch(contents, /"force"/);
  });
});

test("loads a saved server and ignores legacy saved force", async () => {
  await withTempConfig(async (configFile) => {
    await resolveMcpServer(
      ["--save", "demo", "stdio", "node", "-e", "console.log(1)"],
      configFile
    );

    const loaded = await resolveMcpServer(["--load", "demo"], configFile);

    assert.deepEqual(loaded, {
      force: false,
      server: {
        transport: "stdio",
        command: "node",
        args: ["-e", "console.log(1)"],
      },
    });
  });
});

test("refuses to overwrite an existing save without force", async () => {
  await withTempConfig(async (configFile) => {
    await resolveMcpServer(
      ["--save", "demo", "stdio", "node", "-e", "console.log(1)"],
      configFile
    );

    await assert.rejects(
      () => resolveMcpServer(["--save", "demo", "stdio", "node", "-e", "console.log(2)"], configFile),
      /already exists/
    );
  });
});

test("overwrites an existing save with force", async () => {
  await withTempConfig(async (configFile) => {
    await resolveMcpServer(
      ["--save", "demo", "stdio", "node", "-e", "console.log(1)"],
      configFile
    );

    await resolveMcpServer(
      ["-f", "--save", "demo", "stdio", "node", "-e", "console.log(2)"],
      configFile
    );

    const loaded = await resolveMcpServer(["--load", "demo"], configFile);
    assert.deepEqual(loaded.server?.args, ["-e", "console.log(2)"]);
  });
});

test("fails when loading a missing saved server", async () => {
  await withTempConfig(async (configFile) => {
    await assert.rejects(
      () => resolveMcpServer(["--load", "missing"], configFile),
      /was not found/
    );
  });
});

test("AppServices saves, loads, and lists named servers", async () => {
  await withTempConfig(async (configFile) => {
    const services = new AppServices(new AppSession("oneshot", false), configFile);

    await services.saveNamedServer("zebra", ["stdio", "node", "zebra.js"]);
    await services.saveNamedServer("alpha", ["stdio", "node", "alpha.js"]);

    assert.deepEqual(await services.listSavedServers(), ["alpha", "zebra"]);
    assert.deepEqual(await services.loadSavedMcpServerInfo("zebra"), {
      transport: "stdio",
      command: "node",
      args: ["zebra.js"],
    });
  });
});

test("server save command writes config and prints saved info", async () => {
  await withTempConfig(async (configFile) => {
    const services = new AppServices(new AppSession("oneshot", false), configFile);
    const program = CommandRegistry.build(services);

    const { logs, errors } = await captureConsole(async () => {
      await program.parseAsync(["server", "save", "demo", "stdio", "node", "server.js"], { from: "user" });
    });

    assert.deepEqual(errors, []);
    assert.equal(logs.length, 1);
    assert.deepEqual(JSON.parse(logs[0]), {
      transport: "stdio",
      command: "node",
      args: ["server.js"],
    });

    const contents = await readFile(configFile, "utf8");
    assert.match(contents, /"demo":/);
  });
});

test("server load command prints saved info", async () => {
  await withTempConfig(async (configFile) => {
    const services = new AppServices(new AppSession("oneshot", false), configFile);
    await services.saveNamedServer("demo", ["stdio", "node", "server.js"]);
    const program = CommandRegistry.build(services);

    const { logs, errors } = await captureConsole(async () => {
      await program.parseAsync(["server", "load", "demo"], { from: "user" });
    });

    assert.deepEqual(errors, []);
    assert.equal(logs.length, 1);
    assert.deepEqual(JSON.parse(logs[0]), {
      transport: "stdio",
      command: "node",
      args: ["server.js"],
    });
  });
});
