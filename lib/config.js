import { readJson, writeJson } from "./fs.js";

export function createDefaultConfig(paths) {
  return {
    defaultModel: "",
    defaultThinkingLevel: "medium",
    globalConcurrency: 2,
    queueLeaseMs: 120000,
    routeMode: "thread",
    workspaceMode: "dedicated",
    sharedExecutionRoot: "",
    allowProjectExtensions: false,
    enableImageInput: true,
    transports: {
      discord: {
        enabled: false,
        botToken: "",
        allowedGuildIds: [],
        commandName: "pi",
      },
      slack: {
        enabled: false,
        botToken: "",
        appToken: "",
        allowedTeamIds: [],
      },
    },
    routeOverrides: {},
    adminUserIds: [],
  };
}

export function normalizeConfig(paths, value = {}) {
  const base = createDefaultConfig(paths);
  const merged = {
    ...base,
    ...value,
    transports: {
      ...base.transports,
      ...(value.transports || {}),
      discord: { ...base.transports.discord, ...(value.transports?.discord || {}) },
      slack: { ...base.transports.slack, ...(value.transports?.slack || {}) },
    },
    routeOverrides: value.routeOverrides || {},
    adminUserIds: Array.isArray(value.adminUserIds) ? value.adminUserIds : [],
  };
  if (!Array.isArray(merged.transports.discord.allowedGuildIds)) merged.transports.discord.allowedGuildIds = [];
  if (!Array.isArray(merged.transports.slack.allowedTeamIds)) merged.transports.slack.allowedTeamIds = [];
  return merged;
}

export async function loadConfig(paths) {
  const config = await readJson(paths.configPath, null);
  if (!config) return createDefaultConfig(paths);
  return normalizeConfig(paths, config);
}

export async function saveConfig(paths, config) {
  await writeJson(paths.configPath, normalizeConfig(paths, config));
}

export function validateConfig(config) {
  const errors = [];
  const warnings = [];

  if (!config.transports.discord.enabled && !config.transports.slack.enabled) {
    warnings.push("No transport enabled. Enable at least one of discord/slack.");
  }

  if (config.transports.discord.enabled && !config.transports.discord.botToken) {
    errors.push("Discord enabled but botToken is missing.");
  }

  if (config.transports.slack.enabled) {
    if (!config.transports.slack.botToken) errors.push("Slack enabled but botToken is missing.");
    if (!config.transports.slack.appToken) errors.push("Slack enabled but appToken is missing.");
  }

  if (!["thread", "channel", "message"].includes(config.routeMode)) {
    errors.push("routeMode must be one of: thread, channel, message");
  }

  if (!["dedicated", "shared"].includes(config.workspaceMode)) {
    errors.push("workspaceMode must be dedicated or shared");
  }

  return { errors, warnings };
}
