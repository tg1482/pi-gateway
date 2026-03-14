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
            content: `Gateway route context:\n\n${text}`,
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
  };
}
