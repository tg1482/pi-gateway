import path from "node:path";
import { writeFile, readFile } from "node:fs/promises";
import { DiscordTransport } from "../transports/discord.js";
import { SlackTransport } from "../transports/slack.js";
import { ensureDir, pathExists, writeJson } from "../lib/fs.js";
import { getRoutePaths } from "../lib/paths.js";
import { RouteRegistry, createRouteManifest } from "./registry.js";
import { RouteQueueStore } from "./queue-store.js";
import { JournalStore } from "./journal.js";
import { Logger } from "./logger.js";
import { RouteSessionHost } from "./session-host.js";
import { makeRouteKey } from "./route-key.js";

function buildPromptText(input) {
  const parts = [
    `[${input.platform}] route=${input.routeKey}`,
    `User: ${input.userName} (${input.userId})`,
    `Trigger: ${input.trigger}`,
  ];

  if (input.attachments?.length) {
    parts.push("Attachments:");
    for (const attachment of input.attachments) {
      parts.push(`- ${attachment.name} (${attachment.path})`);
    }
  }

  parts.push("", input.text || "");
  return parts.join("\n");
}

async function toImageContent(filePath, mediaType) {
  const data = await readFile(filePath);
  return {
    type: "image",
    source: {
      type: "base64",
      mediaType,
      data: data.toString("base64"),
    },
  };
}

export class PiGatewayDaemon {
  constructor(options) {
    this.paths = options.paths;
    this.config = options.config;
    this.logger = new Logger(this.paths.daemonLogPath);
    this.registry = new RouteRegistry(this.paths);
    this.transports = new Map();

    this.routeContexts = new Map();
    this.routePromises = new Map();
    this.currentRuns = new Map();

    this.workerId = `gateway-${process.pid}`;
    this.heartbeat = undefined;
    this.status = {};
    this.stopping = false;
  }

  async start() {
    await ensureDir(this.paths.workspaceDir);
    await ensureDir(this.paths.runDir);
    await ensureDir(this.paths.logsDir);
    await this.registry.load();

    await this.writeStatus({ phase: "starting" });
    await this.startTransports();

    this.heartbeat = setInterval(() => {
      void this.writeStatus({ phase: "running" });
    }, 15000);

    await this.recoverRoutes();
    await this.scheduleWork();
    await this.writeStatus({ phase: "ready" });
  }

  async startTransports() {
    const onEvent = async (event) => {
      try {
        await this.handleTransportEvent(event);
      } catch (error) {
        await this.logger.error("transport-event-failed", { error: String(error), platform: event.platform });
      }
    };

    if (this.config.transports.discord.enabled) {
      const transport = new DiscordTransport(this.config.transports.discord, this.logger, onEvent);
      await transport.start();
      this.transports.set("discord", transport);
    }

    if (this.config.transports.slack.enabled) {
      const transport = new SlackTransport(this.config.transports.slack, this.logger, onEvent);
      await transport.start();
      this.transports.set("slack", transport);
    }

    await this.logger.info("transports-started", { names: [...this.transports.keys()] });
  }

  resolveRoute(event) {
    const mode = this.config.routeOverrides?.[event.platform]?.routeMode || this.config.routeMode || "thread";
    const routeKey = makeRouteKey({
      platform: event.platform,
      workspaceId: event.workspaceId,
      channelId: event.channelId,
      threadId: event.threadId,
      messageId: event.messageId,
    }, mode);

    return {
      routeKey,
      mode,
      platform: event.platform,
      scope: {
        workspaceId: event.workspaceId,
        channelId: event.channelId,
        threadId: event.threadId,
      },
      routeRef: {
        channelId: event.channelId,
        threadId: event.threadId,
      },
    };
  }

  async handleTransportEvent(event) {
    const route = this.resolveRoute(event);
    const context = await this.ensureRoute(route);
    if (context.journal.hasSource(event.messageId) || context.queue.hasSource(event.messageId)) return;

    const attachments = await this.saveInboundAttachments(context, event);

    const promptText = buildPromptText({
      platform: event.platform,
      routeKey: route.routeKey,
      userName: event.userName,
      userId: event.userId,
      trigger: event.trigger,
      text: event.text,
      attachments,
    });

    let primaryRef;
    try {
      const transport = this.transports.get(event.platform);
      if (transport) {
        const queuedResponse = await transport.sendText(route.routeRef, `Queued for <@${event.userId}>`);
        primaryRef = queuedResponse?.messageRef;
      }
    } catch (error) {
      await this.logger.warn("queue-ack-failed", { routeKey: route.routeKey, error: String(error) });
    }

    if (primaryRef) {
      context.manifest.primaryMessageRef = primaryRef;
      await this.registry.saveManifest(context.manifest);
    }

    await context.journal.append({
      kind: "inbound",
      routeKey: route.routeKey,
      sourceId: event.messageId,
      timestamp: Date.now(),
      authorId: event.userId,
      authorName: event.userName,
      text: event.text,
      trigger: event.trigger,
      platform: event.platform,
      attachments,
    });

    const item = await context.queue.enqueue({
      source: {
        kind: "message",
        sourceId: event.messageId,
        userId: event.userId,
        channelId: event.channelId,
        threadId: event.threadId,
        trigger: event.trigger,
      },
      payload: {
        rawText: event.text,
        promptText,
        attachments,
      },
    });

    await this.logger.info("route-queued", { routeKey: route.routeKey, itemId: item.id, platform: event.platform });
    await this.scheduleWork();
  }

  async saveInboundAttachments(context, event) {
    const incoming = Array.isArray(event.attachments) ? event.attachments : [];
    if (!incoming.length) return [];

    const saved = [];
    for (const attachment of incoming) {
      try {
        const extension = path.extname(attachment.name || "") || ".bin";
        const filePath = path.join(context.routePaths.inboundAttachmentsDir, `${event.messageId}-${attachment.id}${extension}`);

        const response = await fetch(attachment.url, {
          headers: attachment.headers || undefined,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const buffer = Buffer.from(await response.arrayBuffer());
        await writeFile(filePath, buffer);

        saved.push({
          id: attachment.id,
          path: filePath,
          name: attachment.name || path.basename(filePath),
          contentType: attachment.contentType || undefined,
          isImage: (attachment.contentType || "").startsWith("image/"),
        });
      } catch (error) {
        await this.logger.warn("attachment-download-failed", {
          routeKey: context.manifest.routeKey,
          platform: event.platform,
          sourceId: event.messageId,
          attachmentId: attachment.id,
          error: String(error),
        });
      }
    }

    return saved;
  }

  async ensureRoute(route) {
    if (this.routeContexts.has(route.routeKey)) return this.routeContexts.get(route.routeKey);
    if (!this.routePromises.has(route.routeKey)) {
      const promise = this.createRouteContext(route)
        .finally(() => {
          if (this.routePromises.get(route.routeKey) === promise) this.routePromises.delete(route.routeKey);
        });
      this.routePromises.set(route.routeKey, promise);
    }
    return this.routePromises.get(route.routeKey);
  }

  async createRouteContext(route) {
    if (this.routeContexts.has(route.routeKey)) return this.routeContexts.get(route.routeKey);

    const routePaths = getRoutePaths(this.paths, route.routeKey);
    let manifest = await this.registry.loadManifest(route.routeKey);

    if (!manifest) {
      const workspaceMode = this.config.workspaceMode;
      const executionRoot = workspaceMode === "shared"
        ? this.config.sharedExecutionRoot
        : routePaths.dedicatedExecutionRoot;

      if (!executionRoot) throw new Error(`No execution root configured for ${route.routeKey}`);

      const memoryPath = workspaceMode === "dedicated"
        ? path.join(executionRoot, "MEMORY.md")
        : routePaths.sharedMemoryPath;

      manifest = createRouteManifest({
        routeKey: route.routeKey,
        scope: route.scope,
        platform: route.platform,
        workspaceMode,
        executionRoot,
        memoryPath,
      });

      await ensureDir(executionRoot);
      await ensureDir(path.dirname(memoryPath));
      if (!(await pathExists(memoryPath))) await writeFile(memoryPath, "", "utf8");
      await this.registry.saveManifest(manifest);
    }

    await ensureDir(manifest.executionRoot);
    await ensureDir(path.dirname(manifest.memoryPath));
    if (!(await pathExists(manifest.memoryPath))) await writeFile(manifest.memoryPath, "", "utf8");
    await ensureDir(routePaths.routeDir);
    await ensureDir(routePaths.sessionsDir);
    await ensureDir(routePaths.inboundAttachmentsDir);

    const dailyDir = path.join(manifest.executionRoot, "MEMORY_DAILY");
    await ensureDir(dailyDir);
    const today = new Date().toISOString().slice(0, 10);
    const todayMemoryPath = path.join(dailyDir, `${today}.md`);
    if (!(await pathExists(todayMemoryPath))) {
      await writeFile(todayMemoryPath, "", "utf8");
    }

    const queue = new RouteQueueStore(routePaths.queuePath, this.config.queueLeaseMs);
    await queue.load();
    await queue.recoverExpiredLeases();

    const journal = new JournalStore(routePaths.journalPath);
    await journal.load();

    const host = new RouteSessionHost({
      agentDir: this.paths.agentDir,
      config: this.config,
      manifest,
      routePaths,
      journal,
      logger: this.logger,
      uploadFile: async (filePath, options = {}) => {
        const transport = this.transports.get(manifest.platform);
        if (!transport) throw new Error(`Transport ${manifest.platform} not available`);
        return transport.uploadFile(manifest.primaryMessageRef || { channelId: manifest.scope.channelId, threadId: manifest.scope.threadId }, filePath, options);
      },
    });

    const context = {
      manifest,
      routePaths,
      queue,
      journal,
      host,
      routeRef: { channelId: manifest.scope.channelId, threadId: manifest.scope.threadId },
    };

    this.routeContexts.set(route.routeKey, context);
    await this.writeStatus();
    return context;
  }

  async recoverRoutes() {
    for (const summary of this.registry.list()) {
      await this.ensureRoute({
        routeKey: summary.routeKey,
        scope: summary.scope,
        platform: summary.platform,
      }).catch(async (error) => {
        await this.logger.warn("route-recover-failed", { routeKey: summary.routeKey, error: String(error) });
      });
    }
  }

  async scheduleWork() {
    if (this.stopping) return;

    for (const context of this.routeContexts.values()) {
      if (this.currentRuns.size >= this.config.globalConcurrency) return;
      if (this.currentRuns.has(context.manifest.routeKey)) continue;

      const leased = await context.queue.leaseNext(this.workerId);
      if (!leased) continue;

      this.currentRuns.set(context.manifest.routeKey, {
        abort: async () => {
          const session = await context.host.ensureSession();
          await session.abort();
        },
      });

      void this.processQueueItem(context, leased)
        .catch(async (error) => {
          await this.logger.error("queue-item-failed", {
            routeKey: context.manifest.routeKey,
            itemId: leased.id,
            error: String(error),
          });
        })
        .finally(async () => {
          this.currentRuns.delete(context.manifest.routeKey);
          await this.writeStatus();
          await this.scheduleWork();
        });
    }
  }

  async processQueueItem(context, item) {
    let heartbeat;
    let unsubscribe = () => undefined;

    try {
      await context.queue.markRunning(item.id);

      const transport = this.transports.get(context.manifest.platform);
      if (!transport) throw new Error(`Transport unavailable: ${context.manifest.platform}`);

      const messageRef = context.manifest.primaryMessageRef;
      if (messageRef?.messageId) {
        await transport.updateText(context.routeRef, messageRef.messageId, "Running...");
      }

      const session = await context.host.ensureSession();
      context.manifest.sessionFile = session.sessionFile;
      await this.registry.saveManifest(context.manifest);

      heartbeat = setInterval(() => {
        void context.queue.heartbeat(item.id);
      }, Math.max(1000, Math.floor(this.config.queueLeaseMs / 3)));

      let finalAssistantText = "";

      unsubscribe = session.subscribe((event) => {
        if (event.type === "message_end" && event.message?.role === "assistant") {
          const text = (event.message.content || [])
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
          if (text?.trim()) finalAssistantText = text;
        }
      });

      const modelSupportsImages = this.config.enableImageInput && (session.model?.input?.includes?.("image") ?? false);
      const images = modelSupportsImages
        ? await Promise.all(
            (item.payload.attachments || [])
              .filter((attachment) => attachment.isImage && attachment.contentType)
              .map((attachment) => toImageContent(attachment.path, attachment.contentType)),
          )
        : [];

      await session.prompt(item.payload.promptText, {
        expandPromptTemplates: false,
        source: "extension",
        images,
      });

      await context.queue.finish(item.id, "completed");
      await context.journal.append({
        kind: "assistant-final",
        routeKey: context.manifest.routeKey,
        sourceId: item.id,
        timestamp: Date.now(),
        text: finalAssistantText,
      });

      if (messageRef?.messageId) {
        await transport.updateText(context.routeRef, messageRef.messageId, finalAssistantText || "Done.");
      } else {
        await transport.sendText(context.routeRef, finalAssistantText || "Done.");
      }
    } catch (error) {
      const text = String(error);
      const nextState = /abort/i.test(text) ? "cancelled" : "failed";
      await context.queue.finish(item.id, nextState, text);
      await context.journal.append({
        kind: nextState === "cancelled" ? "assistant-cancelled" : "assistant-error",
        routeKey: context.manifest.routeKey,
        sourceId: item.id,
        timestamp: Date.now(),
        error: text,
      });

      const transport = this.transports.get(context.manifest.platform);
      const messageRef = context.manifest.primaryMessageRef;
      if (transport && messageRef?.messageId) {
        const msg = nextState === "cancelled" ? "Run stopped." : `Error: ${text}`;
        await transport.updateText(context.routeRef, messageRef.messageId, msg).catch(() => undefined);
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe();
    }
  }

  async writeStatus(extra = {}) {
    this.status = {
      ...this.status,
      ...extra,
      pid: process.pid,
      routeCount: this.registry.list().length,
      activeRuns: [...this.currentRuns.keys()],
    };
    await writeJson(this.paths.statusPath, this.status);
  }

  async stop() {
    this.stopping = true;
    if (this.heartbeat) clearInterval(this.heartbeat);

    for (const active of this.currentRuns.values()) {
      await active.abort().catch(() => undefined);
    }

    this.currentRuns.clear();

    for (const context of this.routeContexts.values()) {
      await context.host.dispose().catch(() => undefined);
    }

    for (const transport of this.transports.values()) {
      await transport.stop().catch(() => undefined);
    }

    await this.writeStatus({ phase: "stopping" });

    try { await writeFile(this.paths.pidPath, "", "utf8"); } catch {}
    try { await writeFile(this.paths.lockPath, "", "utf8"); } catch {}
  }
}
