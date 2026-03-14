export function makeRouteKey({ platform, workspaceId, channelId, threadId, messageId }, mode = "thread") {
  const base = [platform, workspaceId || "global", channelId || "dm"];

  if (mode === "message") {
    base.push(threadId || "root", messageId || "message");
  } else if (mode === "thread") {
    base.push(threadId || "root");
  }

  return base.join(":");
}
