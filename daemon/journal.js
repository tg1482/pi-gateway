import path from "node:path";
import { readFile } from "node:fs/promises";
import { appendJsonLine, ensureDir } from "../lib/fs.js";

export class JournalStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.entries = [];
    this.sourceIds = new Set();
  }

  async load() {
    await ensureDir(path.dirname(this.filePath));
    try {
      const text = await readFile(this.filePath, "utf8");
      this.entries = text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
      this.sourceIds = new Set(this.entries.map((e) => e.sourceId).filter(Boolean));
    } catch {
      this.entries = [];
      this.sourceIds = new Set();
    }
    return this.entries;
  }

  hasSource(sourceId) { return this.sourceIds.has(sourceId); }

  recent(limit = 25, predicate = () => true) {
    return this.entries.filter(predicate).slice(-limit);
  }

  async append(entry) {
    this.entries.push(entry);
    if (entry.sourceId) this.sourceIds.add(entry.sourceId);
    await appendJsonLine(this.filePath, entry);
  }
}
