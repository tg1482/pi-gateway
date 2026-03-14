import { Client, Events, GatewayIntentBits, Partials } from "discord.js";

function stripBotMention(content, botId) {
  return content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim();
}

export class DiscordTransport {
  constructor(config, logger, onEvent) {
    this.config = config;
    this.logger = logger;
    this.onEvent = onEvent;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
  }

  async start() {
    this.client.once(Events.ClientReady, async (client) => {
      await this.logger.info("discord-ready", { userId: client.user.id, tag: client.user.tag });
    });

    this.client.on(Events.MessageCreate, async (message) => {
      try {
        if (!this.client.user) return;

        if (message.partial) {
          try {
            message = await message.fetch();
          } catch {
            return;
          }
        }

        if (message.author?.bot) return;
        if (message.guildId && this.config.allowedGuildIds?.length > 0 && !this.config.allowedGuildIds.includes(message.guildId)) return;

        const isDm = !message.guildId;
        const botMentioned = message.mentions.users.has(this.client.user.id);
        if (!isDm && !botMentioned) return;

        const channel = message.channel;
        const isThread = channel?.isThread?.() ?? false;
        const threadId = isThread ? channel.id : null;
        const channelId = isThread ? (channel.parentId ?? message.channelId) : message.channelId;

        const rawText = isDm ? (message.content || "") : stripBotMention(message.content || "", this.client.user.id);
        if (!rawText.trim() && message.attachments.size === 0) return;

        const attachments = [...message.attachments.values()].map((attachment) => ({
          id: attachment.id,
          name: attachment.name || `attachment-${attachment.id}`,
          url: attachment.url,
          contentType: attachment.contentType || undefined,
          headers: {},
        }));

        await this.logger.info("discord-message-received", {
          isDm,
          guildId: message.guildId || null,
          channelId,
          threadId,
          userId: message.author.id,
          hasText: Boolean(rawText.trim()),
          attachmentCount: attachments.length,
        });

        await this.onEvent({
          platform: "discord",
          workspaceId: message.guildId ?? "dm",
          channelId,
          threadId,
          messageId: message.id,
          userId: message.author.id,
          userName: message.author.username,
          text: rawText,
          trigger: isDm ? "dm" : "mention",
          attachments,
          rawMessage: message,
        });
      } catch (error) {
        await this.logger.error("discord-message-failed", { error: String(error) });
      }
    });

    await this.client.login(this.config.botToken);
  }

  async stop() {
    this.client.destroy();
  }

  async sendText(routeRef, text, options = {}) {
    const targetId = routeRef.threadId ?? routeRef.channelId;
    const channel = await this.client.channels.fetch(targetId);
    if (!channel || !("send" in channel)) throw new Error(`Discord channel not writable: ${targetId}`);

    const msg = await channel.send({
      content: text,
      allowedMentions: { parse: [] },
    });

    return { messageRef: { channelId: routeRef.channelId, threadId: routeRef.threadId, messageId: msg.id } };
  }

  async updateText(routeRef, messageId, text) {
    const targetId = routeRef.threadId ?? routeRef.channelId;
    const channel = await this.client.channels.fetch(targetId);
    if (!channel || !("messages" in channel)) return { ok: false };
    try {
      const msg = await channel.messages.fetch(messageId);
      await msg.edit({ content: text });
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  async uploadFile(routeRef, filePath, options = {}) {
    const targetId = routeRef.threadId ?? routeRef.channelId;
    const channel = await this.client.channels.fetch(targetId);
    if (!channel || !("send" in channel)) throw new Error(`Discord channel not writable: ${targetId}`);
    const msg = await channel.send({ content: options.title || undefined, files: [filePath] });
    return { messageId: msg.id };
  }
}
