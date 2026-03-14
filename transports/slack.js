import { App, LogLevel } from "@slack/bolt";

function stripMentions(text = "") {
  return text.replace(/<@[A-Z0-9]+>/gi, "").trim();
}

export class SlackTransport {
  constructor(config, logger, onEvent) {
    this.config = config;
    this.logger = logger;
    this.onEvent = onEvent;
    this.app = new App({
      token: config.botToken,
      appToken: config.appToken,
      socketMode: true,
      logLevel: LogLevel.WARN,
    });
    this.botUserId = undefined;
  }

  async start() {
    const auth = await this.app.client.auth.test();
    this.botUserId = auth.user_id;

    this.app.event("app_mention", async ({ event }) => {
      try {
        if (!event?.channel || !event?.user) return;
        if (event.channel_type === "im") return;

        const channelId = event.channel;
        const workspaceId = event.team || null;
        if (workspaceId && this.config.allowedTeamIds?.length > 0 && !this.config.allowedTeamIds.includes(workspaceId)) return;

        const text = stripMentions(event.text || "");
        const attachments = (event.files || []).map((file) => ({
          id: file.id || file.name || String(Math.random()),
          name: file.name || `file-${file.id || "unknown"}`,
          url: file.url_private_download || file.url_private,
          contentType: file.mimetype || undefined,
          headers: { Authorization: `Bearer ${this.config.botToken}` },
        })).filter((file) => file.url);

        await this.onEvent({
          platform: "slack",
          workspaceId: workspaceId || "team",
          channelId,
          threadId: event.thread_ts || null,
          messageId: event.ts,
          userId: event.user,
          userName: event.user,
          text,
          trigger: "mention",
          attachments,
          rawMessage: event,
        });
      } catch (error) {
        await this.logger.error("slack-mention-failed", { error: String(error) });
      }
    });

    this.app.event("message", async ({ event }) => {
      try {
        if (event?.subtype && event.subtype !== "file_share") return;
        if (!event?.channel || !event?.user) return;
        if (event.bot_id) return;
        const isDm = event.channel_type === "im";
        if (!isDm) return;

        const workspaceId = event.team || null;
        if (workspaceId && this.config.allowedTeamIds?.length > 0 && !this.config.allowedTeamIds.includes(workspaceId)) return;

        const text = stripMentions(event.text || "");
        const attachments = (event.files || []).map((file) => ({
          id: file.id || file.name || String(Math.random()),
          name: file.name || `file-${file.id || "unknown"}`,
          url: file.url_private_download || file.url_private,
          contentType: file.mimetype || undefined,
          headers: { Authorization: `Bearer ${this.config.botToken}` },
        })).filter((file) => file.url);

        await this.onEvent({
          platform: "slack",
          workspaceId: workspaceId || "team",
          channelId: event.channel,
          threadId: event.thread_ts || null,
          messageId: event.ts,
          userId: event.user,
          userName: event.user,
          text,
          trigger: "dm",
          attachments,
          rawMessage: event,
        });
      } catch (error) {
        await this.logger.error("slack-message-failed", { error: String(error) });
      }
    });

    await this.app.start();
    await this.logger.info("slack-ready", { botUserId: this.botUserId });
  }

  async stop() {
    await this.app.stop();
  }

  async sendText(routeRef, text, options = {}) {
    const channel = routeRef.channelId;
    const threadTs = routeRef.threadId || options.threadTs;

    const result = await this.app.client.chat.postMessage({
      channel,
      text,
      thread_ts: threadTs || undefined,
      unfurl_links: false,
      unfurl_media: false,
    });

    return { messageRef: { channelId: channel, threadId: threadTs || null, messageId: result.ts } };
  }

  async updateText(routeRef, messageId, text) {
    try {
      await this.app.client.chat.update({ channel: routeRef.channelId, ts: messageId, text });
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  async uploadFile(routeRef, filePath, options = {}) {
    const response = await this.app.client.files.uploadV2({
      channel_id: routeRef.channelId,
      thread_ts: routeRef.threadId || undefined,
      file: filePath,
      filename: options.title || undefined,
      title: options.title || undefined,
    });
    return { messageId: response.files?.[0]?.id || "" };
  }
}
