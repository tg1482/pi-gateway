// Transport event contract
// {
//   platform: 'discord' | 'slack',
//   workspaceId: string | null,
//   channelId: string,
//   threadId: string | null,
//   messageId: string,
//   userId: string,
//   userName: string,
//   text: string,
//   trigger: 'dm' | 'mention' | 'command',
//   replyTo?: string,
// }
//
// Transport adapter contract:
// - start()
// - stop()
// - sendText(routeRef, text, options?) => { messageRef? }
// - uploadFile(routeRef, filePath, options?)
