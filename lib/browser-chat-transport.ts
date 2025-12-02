import { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { getStoredToken, ID_TOKEN_KEY } from "@/lib/auth";

type HeaderValue = Record<string, string> | Headers | undefined;
type HeaderResolver = () => Promise<Record<string, string>> | Record<string, string>;

type BrowserChatTransportOptions = {
  /**
   * Optional header factory, e.g. to inject an Authorization token.
   */
  getHeaders?: HeaderResolver;
  /**
   * Override the base URL of the OpenAI-compatible endpoint.
   */
  baseUrl?: string;
  /**
   * Model to use for chat completions.
   */
  model?: string;
  /**
   * Extra properties to include in the request body for every call.
   */
  body?: Record<string, unknown>;
  /**
   * Called when the transport encounters a non-OK response or network error.
   */
  onError?: (info: TransportErrorInfo | null) => void;
};

export type TransportErrorInfo = {
  status: number;
  statusText: string;
  authed: boolean;
  sub?: number;
  message: string;
};

const DEFAULT_BASE_URL = "https://api.llm7.io/v1";
const DEFAULT_MODEL = "gpt-5-nano";
const TEXT_STREAM_ID = "text-1";
const VERIFY_URL = "https://llm7-api.chigwel137.workers.dev/verify";
const DETECT_IMAGE_GEN_PATH = "/is-image-gen-request";

/**
 * Minimal client-only transport that calls the LLM directly from the browser
 * and turns the streaming response into UIMessageChunk events. Text only.
 */
export class BrowserChatTransport<UI_MESSAGE extends UIMessage = UIMessage>
  implements ChatTransport<UI_MESSAGE>
{
  private getHeaders?: HeaderResolver;
  private baseUrl: string;
  private model: string;
  private extraBody?: Record<string, unknown>;
  private onError?: (info: TransportErrorInfo | null) => void;

  constructor(options: BrowserChatTransportOptions = {}) {
    this.getHeaders = options.getHeaders;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.model = options.model ?? DEFAULT_MODEL;
    this.extraBody = options.body;
    this.onError = options.onError;
  }

  async sendMessages({
    messages,
    abortSignal,
    headers,
    body,
  }: Parameters<ChatTransport<UI_MESSAGE>["sendMessages"]>[0]) {
    const resolvedHeaders = await this.resolveHeaders(headers);
    const authHeader = this.getAuthHeader(resolvedHeaders);
    const authed = this.hasAuthHeader(resolvedHeaders);
    const sub = authed ? await this.getSubscriptionTier(authHeader) : undefined;
    const lastUserText = this.getLastUserText(messages);

    // Clear previous error hint (if any) before we start a new call.
    this.onError?.(null);

    // If the latest user message looks like an image generation request, short-circuit to images.
    if (lastUserText && (await this.isImageGenRequest(lastUserText, resolvedHeaders, abortSignal))) {
      return this.createImageStream({
        prompt: lastUserText,
        headers: resolvedHeaders,
        abortSignal,
        nologo: sub !== undefined && sub >= 2,
        sub,
      });
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...resolvedHeaders,
      },
      body: JSON.stringify({
        model: this.model,
        messages: this.toOpenAIMessages(messages),
        stream: true,
        reasoning_effort: "low",
        reasoning_summary: "auto",
        ...this.extraBody,
        ...body,
      }),
      signal: abortSignal,
    }).catch((err) => {
      this.onError?.({
        status: 0,
        statusText: "Network error",
        authed,
        sub,
        message: err instanceof Error ? err.message : "Network error",
      });
      throw err;
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);

      const info: TransportErrorInfo = {
        status: response.status,
        statusText: response.statusText,
        authed,
        sub,
        message: errorText || response.statusText || "Request failed",
      };

      this.onError?.(info);

      throw new Error(errorText || "Failed to fetch the chat response.");
    }

    if (!response.body) {
      throw new Error("The response body is empty.");
    }

    const textStream = this.parseSseToTextStream(response.body);
    return this.toUiMessageStream(textStream);
  }

  reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return Promise.resolve(null);
  }

  private async resolveHeaders(headers: HeaderValue) {
    const baseHeaders = this.getHeaders ? await this.getHeaders() : undefined;
    const resolvedHeaders =
      headers instanceof Headers ? Object.fromEntries(headers.entries()) : headers;

    return {
      ...(baseHeaders ?? {}),
      ...(resolvedHeaders ?? {}),
    };
  }

  private getAuthHeader(headers: Record<string, string>) {
    return headers.Authorization ?? headers.authorization;
  }

  private hasAuthHeader(headers: Record<string, string>) {
    return Boolean(this.getAuthHeader(headers));
  }

  private async getSubscriptionTier(authHeader?: string): Promise<number | undefined> {
    const token =
      this.getIdToken() ??
      (authHeader ? this.stripBearer(authHeader) : undefined);
    if (!token) return undefined;

    try {
      const res = await fetch(VERIFY_URL, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return undefined;
      const data = (await res.json()) as { sub?: unknown };
      const subNum =
        typeof data?.sub === "number"
          ? data.sub
          : typeof data?.sub === "string"
            ? Number.parseInt(data.sub, 10)
            : undefined;
      return Number.isFinite(subNum) ? (subNum as number) : undefined;
    } catch {
      return undefined;
    }
  }

  private toOpenAIMessages(messages: UI_MESSAGE[]) {
    return messages
      .filter((msg) =>
        msg.role === "system" || msg.role === "user" || msg.role === "assistant"
      )
      .map((msg) => {
        const content = this.extractText(msg);
        return {
          role: msg.role as "system" | "user" | "assistant",
          content,
        };
      })
      .filter((msg) => msg.content.trim().length > 0);
  }

  private getLastUserText(messages: UI_MESSAGE[]) {
    const lastUser = [...messages].reverse().find((msg) => msg.role === "user");
    if (!lastUser) return "";
    return this.extractText(lastUser);
  }

  private extractText(message: UI_MESSAGE) {
    // Prefer structured `parts` used by the UI runtime.
    const parts = (message as unknown as { parts?: unknown }).parts;
    if (Array.isArray(parts)) {
      const text = parts
        .map((part) => {
          if (!part || typeof part !== "object") return "";
          if ("type" in part && (part as { type?: unknown }).type === "text") {
            const maybeText = (part as { text?: unknown }).text;
            if (typeof maybeText === "string") return maybeText;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
      if (text.trim().length > 0) return text;
    }

    // Fallback for legacy `content` shapes.
    const content = (message as unknown as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";

    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          const text = (part as { text?: unknown }).text;
          if (typeof text === "string") return text;
        }
        return "";
      })
      .join("");
  }

  /**
   * Convert OpenAI-style SSE stream to a plain text stream.
   */
  private parseSseToTextStream(
    upstream: ReadableStream<Uint8Array>,
  ): ReadableStream<string> {
    const reader = upstream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    return new ReadableStream<string>({
      async pull(controller) {
        while (true) {
          const { value, done } = await reader.read();

          if (done) {
            buffer = buffer.trim();
            if (buffer) {
              // Process any trailing chunk without final \n\n.
              const { deltas } = extractTextChunks(buffer);
              for (const delta of deltas) {
                controller.enqueue(delta);
              }
            }
            controller.close();
            return;
          }

          buffer += decoder.decode(value, { stream: true });

          let boundary = buffer.indexOf("\n\n");
          while (boundary !== -1) {
            const rawEvent = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const { deltas, done: isDone } = extractTextChunks(rawEvent);
            for (const delta of deltas) {
              controller.enqueue(delta);
            }
            if (isDone) {
              controller.close();
              await reader.cancel().catch(() => {});
              return;
            }
            boundary = buffer.indexOf("\n\n");
          }
        }
      },
      cancel(reason) {
        reader.cancel(reason).catch(() => {});
      },
    });
  }

  /**
   * Detect if a prompt is an image generation request.
   */
  private async isImageGenRequest(
    prompt: string,
    headers: Record<string, string>,
    abortSignal: AbortSignal | undefined,
  ) {
    try {
      const detectUrl = `${this.getApiRoot()}${DETECT_IMAGE_GEN_PATH}?user_input=${encodeURIComponent(prompt)}`;
      const res = await fetch(
        detectUrl,
        { headers, signal: abortSignal },
      );
      if (!res.ok) return false;
      const data = (await res.json()) as { is_image_gen_request?: boolean };
      return Boolean(data?.is_image_gen_request);
    } catch {
      return false;
    }
  }

  /**
   * Create a UIMessageChunk stream for image generation.
   */
  private createImageStream(options: {
    prompt: string;
    headers: Record<string, string>;
    nologo: boolean;
    abortSignal: AbortSignal | undefined;
    sub?: number;
  }): ReadableStream<UIMessageChunk> {
    const { prompt, headers, nologo, abortSignal, sub } = options;
    const seed = Math.floor(Math.random() * 1_000_000);

    const generateImage = async () => {
      const response = await fetch(`${this.baseUrl}/images/generations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify({
          model: "flux",
          prompt,
          nologo,
          seed,
        }),
        signal: abortSignal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => response.statusText);
        this.onError?.({
          status: response.status,
          statusText: response.statusText,
          authed: this.hasAuthHeader(headers),
          sub,
          message: text || "Image generation failed",
        });
        throw new Error(text || "Image generation failed");
      }

      const data = (await response.json()) as {
        data?: Array<{ url?: string; b64_json?: string; mime_type?: string }>;
      };
      const first = data?.data?.[0];
      if (!first) throw new Error("No image returned");

      if (first.url) return { url: first.url, mediaType: first.mime_type ?? "image/png" };
      if (first.b64_json) {
        return {
          url: `data:image/png;base64,${first.b64_json}`,
          mediaType: "image/png",
        };
      }
      throw new Error("No usable image returned");
    };

    return new ReadableStream<UIMessageChunk>({
      start: async (controller) => {
        controller.enqueue({ type: "start" });
        controller.enqueue({ type: "start-step" });
        controller.enqueue({ type: "text-start", id: TEXT_STREAM_ID });
        controller.enqueue({
          type: "text-delta",
          id: TEXT_STREAM_ID,
          delta: "🖼️ Generating image...",
        });

        try {
          const image = await generateImage();
          // Close the placeholder step.
          controller.enqueue({ type: "text-end", id: TEXT_STREAM_ID });
          controller.enqueue({ type: "finish-step" });

          // Start a new step with the final image only.
          controller.enqueue({ type: "start-step" });
          controller.enqueue({ type: "text-start", id: TEXT_STREAM_ID });
          controller.enqueue({
            type: "text-delta",
            id: TEXT_STREAM_ID,
            delta: `![Generated image](${image.url})`,
          });
          controller.enqueue({ type: "text-end", id: TEXT_STREAM_ID });
          controller.enqueue({ type: "finish-step" });
          controller.enqueue({ type: "finish" });
        } catch (err) {
          const message = err instanceof Error ? err.message : "Image generation failed";
          controller.enqueue({
            type: "error",
            errorText: message,
          });
          controller.enqueue({ type: "text-end", id: TEXT_STREAM_ID });
          controller.enqueue({ type: "finish-step" });
          controller.enqueue({ type: "finish" });
        } finally {
          controller.close();
        }
      },
      cancel: async (reason) => {
        // Best-effort abort; fetch respects abortSignal.
        void reason;
      },
    });
  }

  /**
   * Wrap a text stream into the UIMessageChunk stream expected by the UI.
   */
  private toUiMessageStream(
    textStream: ReadableStream<string>,
  ): ReadableStream<UIMessageChunk> {
    const reader = textStream.getReader();

    return new ReadableStream<UIMessageChunk>({
      start(controller) {
        controller.enqueue({ type: "start" });
        controller.enqueue({ type: "start-step" });
        controller.enqueue({ type: "text-start", id: TEXT_STREAM_ID });
      },
      async pull(controller) {
        const { value, done } = await reader.read();

        if (done) {
          controller.enqueue({ type: "text-end", id: TEXT_STREAM_ID });
          controller.enqueue({ type: "finish-step" });
          controller.enqueue({ type: "finish" });
          controller.close();
          return;
        }

        controller.enqueue({
          type: "text-delta",
          id: TEXT_STREAM_ID,
          delta: value,
        });
      },
      async cancel(reason) {
        await reader.cancel(reason);
      },
    });
  }

  private getApiRoot() {
    return this.baseUrl.replace(/\/v1\/?$/, "");
  }

  private getIdToken() {
    return getStoredToken(ID_TOKEN_KEY) ?? undefined;
  }

  private stripBearer(value: string) {
    return value.replace(/^Bearer\s+/i, "").trim();
  }
}

const extractTextChunks = (
  rawEvent: string,
): { deltas: string[]; done: boolean } => {
  const lines = rawEvent.split("\n");
  const deltas: string[] = [];
  let done = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;

    const payload = trimmed.slice(5).trim();
    if (!payload) continue;
    if (payload === "[DONE]") {
      done = true;
      continue;
    }

    try {
      const parsed = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: string } }>;
      };
      const delta = parsed.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta.length > 0) {
        deltas.push(delta);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Failed to parse SSE chunk", err);
    }
  }

  return { deltas, done };
};
