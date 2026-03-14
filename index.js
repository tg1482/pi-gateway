import { readFile } from "node:fs/promises";
import { createDefaultConfig, loadConfig, normalizeConfig, saveConfig, validateConfig } from "./lib/config.js";
import { pathExists } from "./lib/fs.js";
import { getPaths } from "./lib/paths.js";
import { readDaemonLogs, readDaemonStatus, startDaemon, stopDaemon } from "./lib/supervisor.js";

function sendText(pi, text) {
  pi.sendMessage({ customType: "pi-gateway", content: text, display: true });
}

function parseSubcommand(input) {
  const [subcommand = "help", ...args] = input.trim().split(/\s+/).filter(Boolean);
  return { subcommand, args };
}

function helpText(paths) {
  return [
    "`/gateway setup` quick setup (discord/slack tokens)",
    "`/gateway open-config` edit raw config JSON",
    "`/gateway start` start detached gateway daemon",
    "`/gateway stop` stop daemon",
    "`/gateway status` runtime + config status",
    "`/gateway logs [lines]` tail daemon logs",
    "",
    `Config: ${paths.configPath}`,
    `Workspace: ${paths.workspaceDir}`,
    `Logs: ${paths.daemonLogPath}`,
  ].join("\n");
}

async function getEditableConfigText(paths) {
  if (!(await pathExists(paths.configPath))) {
    return JSON.stringify(createDefaultConfig(paths), null, 2);
  }
  try {
    return JSON.stringify(await loadConfig(paths), null, 2);
  } catch {
    return readFile(paths.configPath, "utf8");
  }
}

export default function (pi) {
  pi.registerCommand("gateway", {
    description: "Manage multi-transport Pi gateway",
    handler: async (input, ctx) => {
      const paths = getPaths();
      const { subcommand, args } = parseSubcommand(input);

      if (subcommand === "help") {
        sendText(pi, helpText(paths));
        return;
      }

      if (subcommand === "setup") {
        if (!ctx.hasUI) {
          sendText(pi, `Interactive setup requires Pi UI. Edit ${paths.configPath} manually.`);
          return;
        }

        const config = await loadConfig(paths);

        const enableDiscord = await ctx.ui.input("Enable Discord? (y/n)", config.transports.discord.enabled ? "y" : "n");
        const discordToken = await ctx.ui.input("Discord bot token", config.transports.discord.botToken || "");

        const enableSlack = await ctx.ui.input("Enable Slack? (y/n)", config.transports.slack.enabled ? "y" : "n");
        const slackBotToken = await ctx.ui.input("Slack bot token (xoxb-)", config.transports.slack.botToken || "");
        const slackAppToken = await ctx.ui.input("Slack app token (xapp-)", config.transports.slack.appToken || "");

        config.transports.discord.enabled = /^y/i.test((enableDiscord || "").trim());
        config.transports.discord.botToken = (discordToken || "").trim();

        config.transports.slack.enabled = /^y/i.test((enableSlack || "").trim());
        config.transports.slack.botToken = (slackBotToken || "").trim();
        config.transports.slack.appToken = (slackAppToken || "").trim();

        const normalized = normalizeConfig(paths, config);
        await saveConfig(paths, normalized);

        const validation = validateConfig(normalized);
        let text = `Saved config to ${paths.configPath}`;
        if (validation.errors.length) text += `\n\nErrors:\n- ${validation.errors.join("\n- ")}`;
        if (validation.warnings.length) text += `\n\nWarnings:\n- ${validation.warnings.join("\n- ")}`;
        sendText(pi, text);
        return;
      }

      if (subcommand === "open-config") {
        if (!ctx.hasUI) {
          sendText(pi, `Open ${paths.configPath} in an editor.`);
          return;
        }

        const currentText = await getEditableConfigText(paths);
        const edited = await ctx.ui.editor("Edit pi-gateway config", currentText);
        if (edited == null) return;

        try {
          const parsed = normalizeConfig(paths, JSON.parse(edited));
          await saveConfig(paths, parsed);
          const validation = validateConfig(parsed);
          sendText(pi, validation.errors.length
            ? `Saved ${paths.configPath}\n\nErrors:\n- ${validation.errors.join("\n- ")}`
            : `Saved ${paths.configPath}`);
        } catch (error) {
          sendText(pi, `Could not save config: ${String(error)}`);
        }
        return;
      }

      if (subcommand === "start") {
        const config = await loadConfig(paths);
        const validation = validateConfig(config);
        if (validation.errors.length) {
          sendText(pi, `Config errors:\n- ${validation.errors.join("\n- ")}`);
          return;
        }
        const result = await startDaemon(paths);
        sendText(pi, result.started ? `Started daemon pid ${result.pid}` : result.reason);
        return;
      }

      if (subcommand === "stop") {
        const result = await stopDaemon(paths);
        sendText(pi, result.stopped ? `Stopped daemon pid ${result.pid}` : result.reason);
        return;
      }

      if (subcommand === "status") {
        const [daemon, config] = await Promise.all([readDaemonStatus(paths), loadConfig(paths)]);
        const validation = validateConfig(config);

        const text = [
          `Running: ${daemon.running ? "yes" : "no"}`,
          daemon.pid ? `PID: ${daemon.pid}` : undefined,
          daemon.status?.phase ? `Phase: ${daemon.status.phase}` : undefined,
          daemon.status?.routeCount != null ? `Routes: ${daemon.status.routeCount}` : undefined,
          daemon.status?.activeRuns?.length ? `Active: ${daemon.status.activeRuns.join(", ")}` : undefined,
          daemon.status?.scheduledEvents != null ? `Scheduled events: ${daemon.status.scheduledEvents}` : undefined,
          `Scheduler: ${config.scheduler?.enabled === false ? "disabled" : "enabled"}`,
          `Discord: ${config.transports.discord.enabled ? "enabled" : "disabled"}`,
          `Slack: ${config.transports.slack.enabled ? "enabled" : "disabled"}`,
          validation.errors.length ? `Config errors: ${validation.errors.join("; ")}` : undefined,
          validation.warnings.length ? `Config warnings: ${validation.warnings.join("; ")}` : undefined,
        ].filter(Boolean).join("\n");

        sendText(pi, text);
        return;
      }

      if (subcommand === "logs") {
        const requested = Number(args[0] || "80");
        const lines = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 500) : 80;
        const logs = await readDaemonLogs(paths, lines);
        sendText(pi, logs ? `Last ${lines} lines:\n\n${logs}` : "No logs yet.");
        return;
      }

      sendText(pi, helpText(paths));
    },
  });
}
