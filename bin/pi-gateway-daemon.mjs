#!/usr/bin/env node
import { open, readFile } from "node:fs/promises";
import { getPaths } from "../lib/paths.js";
import { loadConfig, validateConfig } from "../lib/config.js";
import { ensureDir } from "../lib/fs.js";
import { PiGatewayDaemon } from "../daemon/runtime.js";

function parseArgs(argv) {
  let workspace;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--workspace") {
      workspace = argv[i + 1];
      i += 1;
    }
  }
  return { workspace };
}

const args = parseArgs(process.argv.slice(2));
const paths = getPaths({ workspaceDir: args.workspace });
const config = await loadConfig(paths);
const validation = validateConfig(config);
if (validation.errors.length) {
  throw new Error(`Invalid config:\n- ${validation.errors.join("\n- ")}`);
}

await ensureDir(paths.runDir);

let lockHandle;
try {
  lockHandle = await open(paths.lockPath, "wx");
} catch (error) {
  if (error?.code === "EEXIST") {
    let previous;
    try {
      previous = JSON.parse(await readFile(paths.lockPath, "utf8"));
    } catch {
      previous = undefined;
    }

    if (previous?.pid) {
      try {
        process.kill(previous.pid, 0);
        throw new Error(`pi-gateway daemon already running as pid ${previous.pid}`);
      } catch (pidError) {
        if (pidError?.code !== "ESRCH") throw pidError;
      }
    }

    lockHandle = await open(paths.lockPath, "w");
  } else {
    throw error;
  }
}

await lockHandle.writeFile(JSON.stringify({ pid: process.pid }));
await lockHandle.close();

const daemon = new PiGatewayDaemon({ paths, config });

const shutdown = async (exitCode = 0) => {
  await daemon.stop().catch(() => undefined);
  process.exit(exitCode);
};

process.on("SIGINT", () => { void shutdown(0); });
process.on("SIGTERM", () => { void shutdown(0); });
process.on("uncaughtException", (error) => {
  console.error(error);
  void shutdown(1);
});
process.on("unhandledRejection", (error) => {
  console.error(error);
  void shutdown(1);
});

try {
  await daemon.start();
} catch (error) {
  console.error(error);
  await daemon.stop().catch(() => undefined);
  process.exit(1);
}
