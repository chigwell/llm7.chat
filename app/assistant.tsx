"use client";

import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useChatRuntime } from "@assistant-ui/react-ai-sdk";
import { Thread } from "@/components/assistant-ui/thread";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { ThreadListSidebar } from "@/components/assistant-ui/threadlist-sidebar";
import { Separator } from "@/components/ui/separator";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import { API_TOKEN_KEY, getStoredToken } from "@/lib/auth";
import { useAssistantApi, useAssistantState } from "@assistant-ui/react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  BrowserChatTransport,
  type TransportErrorInfo,
} from "@/lib/browser-chat-transport";

const CHAT_NAME_URL = "https://api.llm7.io/get-chat-name";

const useStoredToken = (key: string) =>
  useSyncExternalStore(
    (onChange) => {
      const handler = () => onChange();
      window.addEventListener("storage", handler);
      const id = setInterval(handler, 1000);
      return () => {
        window.removeEventListener("storage", handler);
        clearInterval(id);
      };
    },
    () => getStoredToken(key),
    () => getStoredToken(key),
  );

export const Assistant = () => {
  const [transportError, setTransportError] = useState<TransportErrorInfo | null>(null);
  const apiToken = useStoredToken(API_TOKEN_KEY);

  const transport = useMemo(
    () =>
      new BrowserChatTransport({
        getHeaders: async (): Promise<Record<string, string>> => {
          const headers: Record<string, string> = {};
          const token = getStoredToken(API_TOKEN_KEY);
          if (token) headers.Authorization = `Bearer ${token}`;
          return headers;
        },
        onError: (info) => setTransportError(info),
      }),
    [],
  );

  const runtime = useChatRuntime({
    transport,
  });

  useEffect(() => {
    if (transportError && !transportError.authed && apiToken) {
      setTransportError(null);
    }
  }, [apiToken, transportError]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <SidebarProvider>
        <div className="flex h-dvh w-full pr-0.5">
          <ThreadListSidebar />
          <SidebarInset>
            <AssistantHeader />
            <div className="flex-1 overflow-hidden">
              <Thread
                transportError={transportError}
                onClearTransportError={() => setTransportError(null)}
              />
              <ChatTitleManager />
            </div>
          </SidebarInset>
        </div>
      </SidebarProvider>
    </AssistantRuntimeProvider>
  );
};

const AssistantHeader = () => {
  const threadTitle =
    useAssistantState(({ threads }) => {
      const mainId = threads.mainThreadId;
      return threads.threadItems.find((t) => t.id === mainId)?.title;
    }) ?? "";

  const headerTitle =
    threadTitle.trim().length === 0
      ? "New chat"
      : threadTitle.length > 30
        ? `${threadTitle.slice(0, 28)}...`
        : threadTitle;

  return (
    <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
      <SidebarTrigger />
      <Separator orientation="vertical" className="mr-2 h-4" />
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbPage>{headerTitle}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    </header>
  );
};

const ChatTitleManager = () => {
  const api = useAssistantApi();
  const apiToken = useStoredToken(API_TOKEN_KEY) || "none";
  const mainThreadId = useAssistantState(
    ({ threads }) => threads.mainThreadId,
  );
  const currentTitle =
    useAssistantState(({ threads }) => {
      const title =
        threads.threadItems.find((t) => t.id === threads.mainThreadId)?.title;
      return title ?? "";
    }) ?? "";
  const firstUserMessage = useAssistantState(({ thread }) =>
    thread.messages.find((m) => m.role === "user"),
  );

  const attempted = useRef(new Set<string>());

  useEffect(() => {
    const threadId = mainThreadId;
    if (!threadId) return;
    if (attempted.current.has(threadId)) return;

    const parts = (firstUserMessage?.content ?? []) as Array<{
      type?: string;
      text?: string;
    }>;
    const userText = parts
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join(" ")
      .trim();

    if (!userText) return;
    if (currentTitle && currentTitle.trim().length > 0) {
      attempted.current.add(threadId);
      return;
    }

    if (!apiToken) return;

    const itemApi = api.threads().item({ id: threadId });
    attempted.current.add(threadId);

    const run = async () => {
      try {
        // Ensure the thread is initialized so rename succeeds.
        const state = itemApi.getState();
        if (state.status === "new") {
          await itemApi.initialize();
        }
        const response = await fetch(
          `${CHAT_NAME_URL}?user_input=${encodeURIComponent(userText)}`,
          {
            headers: {
              Authorization: `Bearer ${apiToken}`,
            },
          },
        );

        if (!response.ok) return;
        const data = (await response.json()) as { chat_name?: string };
        const chatName = typeof data.chat_name === "string"
          ? data.chat_name.trim()
          : "";
        if (!chatName) return;

        await itemApi.rename(chatName);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("Failed to generate chat name", err);
      }
    };

    run();
  }, [api, apiToken, currentTitle, firstUserMessage, mainThreadId]);

  return null;
};
