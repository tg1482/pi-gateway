import { Type } from "@sinclair/typebox";

export function createRouteSessionExtension(runtime) {
  return (pi) => {
    pi.on("context", async (event) => {
      const text = await runtime.getInjectedContext();
      if (!text?.trim()) return undefined;
      return {
        messages: [
          {
            role: "user",
            content: `Gateway route context:\n\n${text}\n\nScheduled events directory: ${runtime.eventsDir}\nRoute key: ${runtime.routeKey}`,
            timestamp: Date.now(),
          },
          ...event.messages,
        ],
      };
    });

    pi.registerTool({
      name: "gateway_upload",
      label: "Gateway Upload",
      description: "Upload local file back to current chat route.",
      parameters: Type.Object({
        path: Type.String({ description: "Local file path" }),
        title: Type.Optional(Type.String({ description: "Optional title" })),
      }),
      async execute(_id, params) {
        const result = await runtime.uploadFile(params.path, { title: params.title });
        return {
          content: [{ type: "text", text: `Uploaded ${params.path}.` }],
          details: result,
        };
      },
    });

    pi.registerTool({
      name: "gateway_schedule_create",
      label: "Gateway Schedule Create",
      description: "Create a scheduled event for this route (immediate, one-shot, or periodic cron).",
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: "Optional event id (filename-safe)." })),
        type: Type.Union([
          Type.Literal("immediate"),
          Type.Literal("one-shot"),
          Type.Literal("periodic"),
        ]),
        text: Type.String({ description: "Instruction/prompt to run when event triggers." }),
        at: Type.Optional(Type.String({ description: "ISO datetime for one-shot events." })),
        schedule: Type.Optional(Type.String({ description: "Cron expression for periodic events." })),
        timezone: Type.Optional(Type.String({ description: "Timezone for periodic events, e.g. America/Chicago." })),
        deliver: Type.Optional(Type.Union([Type.Literal("post"), Type.Literal("silent")], { description: "Whether to post back to chat." })),
        enabled: Type.Optional(Type.Boolean({ description: "Whether event is enabled." })),
      }),
      async execute(_id, params) {
        const result = await runtime.scheduleEvent(params);
        return {
          content: [{ type: "text", text: `Scheduled ${params.type} event '${result.id}'.` }],
          details: result,
        };
      },
    });

    pi.registerTool({
      name: "gateway_schedule_list",
      label: "Gateway Schedule List",
      description: "List scheduled events for this route.",
      parameters: Type.Object({}),
      async execute() {
        const events = await runtime.listEvents();
        const summary = events.length
          ? events.map((event) => {
              const spec = event.event || {};
              const when = spec.type === "one-shot"
                ? spec.at
                : spec.type === "periodic"
                  ? `${spec.schedule} (${spec.timezone || "UTC"})`
                  : "now";
              return `- ${event.id}: ${spec.type} -> ${when} [deliver=${spec.deliver || "post"}]`;
            }).join("\n")
          : "No scheduled events.";
        return {
          content: [{ type: "text", text: summary }],
          details: { events },
        };
      },
    });

    pi.registerTool({
      name: "gateway_schedule_cancel",
      label: "Gateway Schedule Cancel",
      description: "Cancel (delete) a scheduled event by id for this route.",
      parameters: Type.Object({
        id: Type.String({ description: "Event id to delete." }),
      }),
      async execute(_id, params) {
        const result = await runtime.cancelEvent(params.id);
        return {
          content: [{ type: "text", text: `Cancelled scheduled event '${result.id}'.` }],
          details: result,
        };
      },
    });
  };
}
