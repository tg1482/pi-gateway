import { readFile } from "node:fs/promises";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { pathExists } from "../lib/fs.js";
import { createRouteSessionExtension } from "./session-extension.js";

async function buildInjectedContext(memoryPath, executionRoot, journal) {
  let memory = "";
  try { memory = await readFile(memoryPath, "utf8"); } catch {}

  const today = new Date().toISOString().slice(0, 10);
  const dailyMemoryPath = `${executionRoot}/MEMORY_DAILY/${today}.md`;
  let dailyMemory = "";
  try { dailyMemory = await readFile(dailyMemoryPath, "utf8"); } catch {}

  const recent = journal.recent(20, (entry) => ["inbound", "ambient", "assistant-final", "assistant-error"].includes(entry.kind));
  const history = recent.map((entry) => {
    if (entry.kind === "assistant-final") return `assistant: ${entry.text || ""}`;
    return `${entry.authorName || entry.authorId || "user"}: ${entry.text || ""}`;
  }).join("\n");

  return [
    `Memory files:\n- ${memoryPath}\n- ${dailyMemoryPath}`,
    memory?.trim() ? `MEMORY.md:\n${memory.trim()}` : "",
    dailyMemory?.trim() ? `Daily memory (${today}):\n${dailyMemory.trim()}` : "",
    history?.trim() ? `Recent route history:\n${history}` : "",
  ].filter(Boolean).join("\n\n");
}

export class RouteSessionHost {
  constructor(options) {
    this.agentDir = options.agentDir;
    this.config = options.config;
    this.manifest = options.manifest;
    this.routePaths = options.routePaths;
    this.journal = options.journal;
    this.logger = options.logger;
    this.uploadFile = options.uploadFile;
    this.scheduleEvent = options.scheduleEvent;
    this.listEvents = options.listEvents;
    this.cancelEvent = options.cancelEvent;
    this.routeKey = options.routeKey;
    this.eventsDir = options.eventsDir;
    this.session = undefined;
    this.sessionPromise = undefined;
  }

  async ensureSession() {
    if (this.session) return this.session;
    if (!this.sessionPromise) {
      this.sessionPromise = this.createSession()
        .then((session) => {
          this.session = session;
          this.manifest.sessionFile = session.sessionFile;
          return session;
        })
        .finally(() => {
          this.sessionPromise = undefined;
        });
    }
    return this.sessionPromise;
  }

  async createSession() {
    const authStorage = AuthStorage.create(`${this.agentDir}/auth.json`);
    const modelRegistry = new ModelRegistry(authStorage, `${this.agentDir}/models.json`);
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 2 },
      images: { blockImages: !this.config.enableImageInput },
    });

    const resourceLoader = new DefaultResourceLoader({
      cwd: this.manifest.executionRoot,
      agentDir: this.agentDir,
      settingsManager,
      noExtensions: !this.config.allowProjectExtensions,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [
        createRouteSessionExtension({
          getInjectedContext: () => buildInjectedContext(this.manifest.memoryPath, this.manifest.executionRoot, this.journal),
          uploadFile: this.uploadFile,
          scheduleEvent: this.scheduleEvent,
          listEvents: this.listEvents,
          cancelEvent: this.cancelEvent,
          routeKey: this.routeKey,
          eventsDir: this.eventsDir,
        }),
      ],
    });

    await resourceLoader.reload();

    const sessionManager = (this.manifest.sessionFile && await pathExists(this.manifest.sessionFile))
      ? SessionManager.open(this.manifest.sessionFile)
      : SessionManager.create(this.manifest.executionRoot, this.routePaths.sessionsDir);

    let model;
    if (this.config.defaultModel) {
      const [provider, ...rest] = this.config.defaultModel.split("/");
      if (provider && rest.length) model = modelRegistry.find(provider, rest.join("/"));
    }

    const { session } = await createAgentSession({
      cwd: this.manifest.executionRoot,
      agentDir: this.agentDir,
      authStorage,
      modelRegistry,
      sessionManager,
      settingsManager,
      resourceLoader,
      model,
      thinkingLevel: this.config.defaultThinkingLevel,
    });

    await session.bindExtensions({
      uiContext: {
        notify: async () => undefined,
        input: async () => undefined,
        editor: async () => undefined,
        setWidget: async () => undefined,
      },
      commandContextActions: {
        waitForIdle: async () => undefined,
        newSession: async () => ({ cancelled: true }),
        fork: async () => ({ cancelled: true }),
        navigateTree: async () => ({ cancelled: true }),
        switchSession: async () => ({ cancelled: true }),
        reload: async () => undefined,
      },
      onError: (error) => { void this.logger.error("route-session-extension-error", { error: String(error) }); },
    });

    return session;
  }

  async dispose() {
    const session = this.session ?? await this.sessionPromise?.catch(() => undefined);
    if (!session) return;
    session.dispose();
    if (this.session === session) this.session = undefined;
  }
}
