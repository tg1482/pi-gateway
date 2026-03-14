import { appendJsonLine, ensureDir } from "../lib/fs.js";
import path from "node:path";

export class Logger {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async log(level, event, details = {}) {
    await ensureDir(path.dirname(this.filePath));
    await appendJsonLine(this.filePath, {
      ts: new Date().toISOString(),
      level,
      event,
      ...details,
    });
  }

  info(event, details = {}) { return this.log("info", event, details); }
  warn(event, details = {}) { return this.log("warn", event, details); }
  error(event, details = {}) { return this.log("error", event, details); }
}
