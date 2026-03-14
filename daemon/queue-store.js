import { randomUUID } from "node:crypto";
import path from "node:path";
import { ensureDir, readJson, writeJson } from "../lib/fs.js";

function normalize(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { version: 1, items: [] };
  return {
    version: 1,
    items: Array.isArray(value.items) ? value.items : [],
  };
}

export class RouteQueueStore {
  constructor(filePath, leaseMs) {
    this.filePath = filePath;
    this.leaseMs = leaseMs;
    this.data = { version: 1, items: [] };
  }

  async load() {
    this.data = normalize(await readJson(this.filePath, { version: 1, items: [] }));
    return this.data;
  }

  async save() {
    await ensureDir(path.dirname(this.filePath));
    await writeJson(this.filePath, this.data);
  }

  list() { return this.data.items.slice(); }

  hasSource(sourceId) {
    return this.data.items.some((i) => i.source?.sourceId === sourceId && i.state !== "cancelled");
  }

  async enqueue(input) {
    const item = {
      id: randomUUID(),
      state: "queued",
      lease: undefined,
      error: undefined,
      ...input,
    };
    this.data.items.push(item);
    await this.save();
    return item;
  }

  async leaseNext(workerId, now = Date.now()) {
    const item = this.data.items.find((i) => i.state === "queued");
    if (!item) return undefined;
    item.state = "leased";
    item.lease = { workerId, acquiredAt: now, expiresAt: now + this.leaseMs };
    await this.save();
    return item;
  }

  async recoverExpiredLeases(now = Date.now()) {
    let changed = false;
    for (const item of this.data.items) {
      if ((item.state === "leased" || item.state === "running") && item.lease?.expiresAt <= now) {
        item.state = "queued";
        item.lease = undefined;
        item.error = "Recovered abandoned work after lease expiry.";
        changed = true;
      }
    }
    if (changed) await this.save();
  }

  async markRunning(itemId) {
    const item = this.data.items.find((i) => i.id === itemId);
    if (!item) return;
    item.state = "running";
    if (item.lease) item.lease.expiresAt = Date.now() + this.leaseMs;
    await this.save();
  }

  async heartbeat(itemId) {
    const item = this.data.items.find((i) => i.id === itemId);
    if (!item?.lease) return;
    item.lease.expiresAt = Date.now() + this.leaseMs;
    await this.save();
  }

  async finish(itemId, nextState, error) {
    const item = this.data.items.find((i) => i.id === itemId);
    if (!item) return;
    item.state = nextState;
    item.error = error;
    item.lease = undefined;
    await this.save();
  }
}
