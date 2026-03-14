import path from "node:path";
import { rm, readdir } from "node:fs/promises";
import { Cron } from "croner";
import { ensureDir, readJson } from "../lib/fs.js";
import { getRoutePaths } from "../lib/paths.js";

function eventKey(routeKey, fileName) {
  return `${routeKey}:${fileName}`;
}

function normalizeEvent(fileName, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Event must be a JSON object");
  if (!["immediate", "one-shot", "periodic"].includes(value.type)) {
    throw new Error(`Invalid event type in ${fileName}`);
  }

  const text = typeof value.text === "string" ? value.text.trim() : "";
  if (!text) throw new Error(`Missing text in ${fileName}`);

  const normalized = {
    type: value.type,
    text,
    timezone: typeof value.timezone === "string" && value.timezone.trim() ? value.timezone.trim() : "UTC",
    schedule: typeof value.schedule === "string" ? value.schedule.trim() : "",
    at: typeof value.at === "string" ? value.at.trim() : "",
    deliver: value.deliver === "silent" ? "silent" : "post",
    enabled: value.enabled !== false,
  };

  if (normalized.type === "one-shot" && !normalized.at) {
    throw new Error(`Missing at timestamp for one-shot in ${fileName}`);
  }
  if (normalized.type === "periodic" && !normalized.schedule) {
    throw new Error(`Missing schedule for periodic in ${fileName}`);
  }

  return normalized;
}

export class RouteEventsWatcher {
  constructor(options) {
    this.paths = options.paths;
    this.registry = options.registry;
    this.logger = options.logger;
    this.onFire = options.onFire;
    this.intervalMs = options.intervalMs || 10000;

    this.running = false;
    this.timer = undefined;
    this.entries = new Map();
    this.timeouts = new Map();
    this.crons = new Map();
  }

  getScheduledCount() {
    return this.entries.size;
  }

  async start() {
    this.running = true;
    await this.sync();
    this.timer = setInterval(() => {
      void this.sync();
    }, this.intervalMs);
  }

  async stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;

    for (const timeout of this.timeouts.values()) clearTimeout(timeout);
    this.timeouts.clear();

    for (const cron of this.crons.values()) cron.stop();
    this.crons.clear();

    this.entries.clear();
  }

  async sync() {
    if (!this.running) return;

    const seen = new Set();
    for (const route of this.registry.list()) {
      const routePaths = getRoutePaths(this.paths, route.routeKey);
      await ensureDir(routePaths.eventsDir);

      let files = [];
      try {
        files = (await readdir(routePaths.eventsDir)).filter((name) => name.endsWith(".json"));
      } catch {
        files = [];
      }

      for (const fileName of files) {
        const filePath = path.join(routePaths.eventsDir, fileName);
        const raw = await readJson(filePath, null);
        if (!raw) continue;

        const key = eventKey(route.routeKey, fileName);
        seen.add(key);

        try {
          const event = normalizeEvent(fileName, raw);
          if (!event.enabled) {
            this.unschedule(key);
            continue;
          }

          const hash = JSON.stringify(event);
          const prev = this.entries.get(key);
          if (prev?.hash === hash) continue;

          this.unschedule(key);
          this.entries.set(key, { routeKey: route.routeKey, fileName, filePath, event, hash });
          await this.install(key);
        } catch (error) {
          await this.logger.warn("event-invalid", { routeKey: route.routeKey, fileName, error: String(error) });
        }
      }
    }

    for (const key of [...this.entries.keys()]) {
      if (!seen.has(key)) this.unschedule(key);
    }
  }

  unschedule(key) {
    const timeout = this.timeouts.get(key);
    if (timeout) clearTimeout(timeout);
    this.timeouts.delete(key);

    const cron = this.crons.get(key);
    if (cron) cron.stop();
    this.crons.delete(key);

    this.entries.delete(key);
  }

  async install(key) {
    const entry = this.entries.get(key);
    if (!entry) return;

    const { routeKey, fileName, filePath, event } = entry;

    if (event.type === "immediate") {
      await this.fire({ routeKey, fileName, filePath, event, deleteAfter: true });
      return;
    }

    if (event.type === "one-shot") {
      const at = Date.parse(event.at);
      if (!Number.isFinite(at)) {
        await this.logger.warn("event-invalid-time", { routeKey, fileName, at: event.at });
        return;
      }

      const delay = Math.max(0, at - Date.now());
      const timeout = setTimeout(() => {
        void this.fire({ routeKey, fileName, filePath, event, deleteAfter: true });
      }, delay);

      this.timeouts.set(key, timeout);
      await this.logger.info("event-scheduled-one-shot", { routeKey, fileName, delayMs: delay });
      return;
    }

    const cron = new Cron(event.schedule, { timezone: event.timezone }, () => {
      void this.fire({ routeKey, fileName, filePath, event, deleteAfter: false });
    });
    this.crons.set(key, cron);

    await this.logger.info("event-scheduled-periodic", {
      routeKey,
      fileName,
      schedule: event.schedule,
      timezone: event.timezone,
      nextRun: cron.nextRun()?.toISOString() || null,
    });
  }

  async fire({ routeKey, fileName, filePath, event, deleteAfter }) {
    const eventId = path.basename(fileName, ".json");
    const sourceId = `event:${routeKey}:${eventId}:${Date.now()}`;

    try {
      await this.logger.info("event-fire", { routeKey, fileName, type: event.type });
      await this.onFire({
        routeKey,
        eventId,
        sourceId,
        text: event.text,
        deliver: event.deliver,
        type: event.type,
      });
    } catch (error) {
      await this.logger.error("event-fire-failed", { routeKey, fileName, error: String(error) });
    } finally {
      if (deleteAfter) {
        await rm(filePath, { force: true }).catch(() => undefined);
        this.unschedule(eventKey(routeKey, fileName));
      }
    }
  }
}
