import { mkdir, readFile, writeFile, appendFile, stat } from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

export async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(filePath, fallback = undefined) {
  try {
    const text = await readFile(filePath, "utf8");
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function appendJsonLine(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

export async function tailFile(filePath, lines = 100) {
  try {
    const text = await readFile(filePath, "utf8");
    const chunks = text.split(/\r?\n/).filter(Boolean);
    return chunks.slice(-lines).join("\n");
  } catch {
    return "";
  }
}

export function sanitizeSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "_");
}
