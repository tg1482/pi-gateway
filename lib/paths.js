import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeSegment } from "./fs.js";

const packageRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

export function getPaths(options = {}) {
  const agentDir = options.agentDir ?? path.join(homedir(), ".pi", "agent");
  const workspaceDir = options.workspaceDir ?? path.join(agentDir, "pi-gateway");

  return {
    packageRoot,
    agentDir,
    workspaceDir,
    configPath: path.join(workspaceDir, "config.json"),
    runDir: path.join(workspaceDir, "run"),
    logsDir: path.join(workspaceDir, "logs"),
    eventsDir: path.join(workspaceDir, "events"),
    routesDir: path.join(workspaceDir, "routes"),
    routeWorkspacesDir: path.join(workspaceDir, "workspaces"),
    statusPath: path.join(workspaceDir, "run", "status.json"),
    pidPath: path.join(workspaceDir, "run", "daemon.pid"),
    lockPath: path.join(workspaceDir, "run", "daemon.lock"),
    daemonLogPath: path.join(workspaceDir, "logs", "daemon.log"),
    registryPath: path.join(workspaceDir, "routes", "registry.json"),
    daemonEntry: path.join(packageRoot, "bin", "pi-gateway-daemon.mjs"),
  };
}

export function getRoutePaths(paths, routeKey) {
  const slug = sanitizeSegment(routeKey);
  const routeDir = path.join(paths.routesDir, slug);

  return {
    routeDir,
    manifestPath: path.join(routeDir, "manifest.json"),
    journalPath: path.join(routeDir, "journal.jsonl"),
    queuePath: path.join(routeDir, "queue.json"),
    sessionsDir: path.join(routeDir, "sessions"),
    inboundAttachmentsDir: path.join(routeDir, "attachments", "inbound"),
    eventsDir: path.join(routeDir, "events"),
    dedicatedExecutionRoot: path.join(paths.routeWorkspacesDir, slug),
    sharedMemoryPath: path.join(routeDir, "MEMORY.md"),
  };
}
