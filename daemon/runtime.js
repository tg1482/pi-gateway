import path from "node:path";
import { writeFile, readFile, readdir, rm } from "node:fs/promises";
import { DiscordTransport } from "../transports/discord.js";
import { SlackTransport } from "../transports/slack.js";
import { ensureDir, pathExists, readJson, sanitizeSegment, writeJson } from "../lib/fs.js";
import { getRoutePaths } from "../lib/paths.js";
import { RouteRegistry, createRouteManifest } from "./registry.js";
import { RouteQueueStore } from "./queue-store.js";
import { JournalStore } from "./journal.js";
import { Logger } from "./logger.js";
import { RouteSessionHost } from "./session-host.js";
import { makeRouteKey } from "./route-key.js";
import { RouteEventsWatcher } from "./events-watcher.js";

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
    this.eventsWatcher = undefined;
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
    await this.startEventsWatcher();
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

  async startEventsWatcher() {
    if (this.config.scheduler?.enabled === false) return;

    this.eventsWatcher = new RouteEventsWatcher({
      paths: this.paths,
      registry: this.registry,
      logger: this.logger,
      intervalMs: this.config.scheduler?.pollIntervalMs || 10000,
      onFire: async (event) => {
        await this.handleScheduledEvent(event);
      },
    });
    await this.eventsWatcher.start();
  }

  async handleScheduledEvent(event) {
    const summary = this.registry.list().find((route) => route.routeKey === event.routeKey);
    if (!summary) throw new Error(`Unknown route key for scheduled event: ${event.routeKey}`);

    const context = await this.ensureRoute({
      routeKey: summary.routeKey,
      scope: summary.scope,
      platform: summary.platform,
    });

    if (context.journal.hasSource(event.sourceId) || context.queue.hasSource(event.sourceId)) return;

    const promptText = [
      `[schedule] route=${event.routeKey}`,
      `Type: ${event.type}`,
      `Event ID: ${event.eventId}`,
      "",
      event.text,
    ].join("\n");

    await context.journal.append({
      kind: "scheduled-trigger",
      routeKey: event.routeKey,
      sourceId: event.sourceId,
      timestamp: Date.now(),
      text: event.text,
      eventId: event.eventId,
      eventType: event.type,
      deliver: event.deliver,
    });

    const item = await context.queue.enqueue({
      source: {
        kind: "scheduled",
        sourceId: event.sourceId,
        eventId: event.eventId,
        eventType: event.type,
        deliver: event.deliver,
      },
      payload: {
        rawText: event.text,
        promptText,
        attachments: [],
      },
    });

    await this.logger.info("route-scheduled-queued", { routeKey: event.routeKey, eventId: event.eventId, itemId: item.id });
    await this.scheduleWork();
  }

  async createRouteEvent(routeKey, input) {
    const summary = this.registry.list().find((route) => route.routeKey === routeKey);
    if (!summary) throw new Error(`Route not found: ${routeKey}`);

    const routePaths = getRoutePaths(this.paths, routeKey);
    await ensureDir(routePaths.eventsDir);

    const id = sanitizeSegment(input.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const fileName = `${id}.json`;
    const filePath = path.join(routePaths.eventsDir, fileName);

    const type = input.type;
    if (!["immediate", "one-shot", "periodic"].includes(type)) {
      throw new Error("type must be one of: immediate, one-shot, periodic");
    }

    const text = String(input.text || "").trim();
    if (!text) throw new Error("text is required");

    const event = {
      type,
      text,
      enabled: input.enabled !== false,
      deliver: input.deliver === "silent" ? "silent" : "post",
    };

    if (event.type === "one-shot") {
      if (!input.at || !Number.isFinite(Date.parse(input.at))) {
        throw new Error("one-shot events require valid 'at' ISO timestamp");
      }
      event.at = input.at;
    }

    if (event.type === "periodic") {
      if (!input.schedule || !String(input.schedule).trim()) {
        throw new Error("periodic events require non-empty 'schedule'");
      }
      event.schedule = String(input.schedule).trim();
      event.timezone = String(input.timezone || "UTC").trim() || "UTC";
    }

    await writeJson(filePath, event);
    await this.eventsWatcher?.sync();

    return { id, filePath, event };
  }

  async listRouteEvents(routeKey) {
    const routePaths = getRoutePaths(this.paths, routeKey);
    await ensureDir(routePaths.eventsDir);

    const files = (await readdir(routePaths.eventsDir)).filter((name) => name.endsWith(".json")).sort();
    const events = [];
    for (const fileName of files) {
      const filePath = path.join(routePaths.eventsDir, fileName);
      const event = await readJson(filePath, null);
      if (!event) continue;
      events.push({
        id: path.basename(fileName, ".json"),
        filePath,
        event,
      });
    }
    return events;
  }

  async deleteRouteEvent(routeKey, id) {
    const routePaths = getRoutePaths(this.paths, routeKey);
    const safeId = sanitizeSegment(id);
    const filePath = path.join(routePaths.eventsDir, `${safeId}.json`);
    await rm(filePath, { force: true });
    await this.eventsWatcher?.sync();
    return { id: safeId, removed: true };
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
    await ensureDir(routePaths.eventsDir);

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
      scheduleEvent: async (input) => this.createRouteEvent(manifest.routeKey, input),
      listEvents: async () => this.listRouteEvents(manifest.routeKey),
      cancelEvent: async (id) => this.deleteRouteEvent(manifest.routeKey, id),
      routeKey: manifest.routeKey,
      eventsDir: routePaths.eventsDir,
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

      const sourceKind = item.source?.kind || "message";
      const isScheduled = sourceKind === "scheduled";

      const messageRef = context.manifest.primaryMessageRef;
      if (!isScheduled && messageRef?.messageId) {
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

      const silent = finalAssistantText.trim() === "[SILENT]" || finalAssistantText.trim().startsWith("[SILENT]");
      const deliverMode = item.source?.deliver === "silent" ? "silent" : "post";

      if (isScheduled) {
        if (deliverMode !== "silent" && !silent) {
          await transport.sendText(context.routeRef, finalAssistantText || "Done.");
        }
      } else if (messageRef?.messageId) {
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
      const isScheduled = item.source?.kind === "scheduled";
      if (transport && isScheduled) {
        if (item.source?.deliver !== "silent") {
          const msg = nextState === "cancelled" ? "Scheduled run stopped." : `Scheduled run error: ${text}`;
          await transport.sendText(context.routeRef, msg).catch(() => undefined);
        }
      } else if (transport && messageRef?.messageId) {
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
      scheduledEvents: this.eventsWatcher?.getScheduledCount?.() || 0,
    };
    await writeJson(this.paths.statusPath, this.status);
  }

  async stop() {
    this.stopping = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.eventsWatcher) await this.eventsWatcher.stop().catch(() => undefined);

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
