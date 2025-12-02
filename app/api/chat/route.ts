import { createOpenAI } from "@ai-sdk/openai";
import {
  streamText,
  convertToModelMessages,
  type UIMessage,
} from "ai";

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return new Response(
      JSON.stringify({ error: "Missing auth token" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  const llm7 = createOpenAI({
    baseURL: "https://api.llm7.io/v1",
    apiKey: token,
  });

  const result = streamText({
    model: llm7.chat("gpt-5-nano"),
    messages: convertToModelMessages(messages),
    providerOptions: {
      openai: {
        reasoningEffort: "low",
        reasoningSummary: "auto",
      },
    },
  });

  return result.toUIMessageStreamResponse({
    sendReasoning: true,
  });
}
