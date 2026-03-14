import path from "node:path";
import { ensureDir, readJson, writeJson } from "../lib/fs.js";
import { getRoutePaths } from "../lib/paths.js";

function normalizeRegistry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { version: 1, routes: {} };
  return {
    version: 1,
    routes: value.routes && typeof value.routes === "object" ? value.routes : {},
  };
}

export function createRouteManifest(input) {
  return {
    version: 1,
    routeKey: input.routeKey,
    scope: input.scope,
    platform: input.platform,
    workspaceMode: input.workspaceMode,
    executionRoot: input.executionRoot,
    memoryPath: input.memoryPath,
    sessionFile: undefined,
    primaryMessageRef: undefined,
  };
}

export class RouteRegistry {
  constructor(paths) {
    this.paths = paths;
    this.registry = { version: 1, routes: {} };
  }

  async load() {
    this.registry = normalizeRegistry(await readJson(this.paths.registryPath, { version: 1, routes: {} }));
    return this.registry;
  }

  async save() {
    await ensureDir(path.dirname(this.paths.registryPath));
    await writeJson(this.paths.registryPath, this.registry);
  }

  list() {
    return Object.values(this.registry.routes);
  }

  async loadManifest(routeKey) {
    const routePaths = getRoutePaths(this.paths, routeKey);
    return await readJson(routePaths.manifestPath, null);
  }

  async saveManifest(manifest) {
    const routePaths = getRoutePaths(this.paths, manifest.routeKey);
    await ensureDir(routePaths.routeDir);
    await writeJson(routePaths.manifestPath, manifest);
    this.registry.routes[manifest.routeKey] = {
      routeKey: manifest.routeKey,
      scope: manifest.scope,
      platform: manifest.platform,
    };
    await this.save();
  }
}
