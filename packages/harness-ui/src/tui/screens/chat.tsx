import React, { useState, useCallback, useEffect, useRef } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { MessageList, type ChatMessage, type ToolCallItem } from "../components/message-list.js";
import { StatusBar } from "../components/status-bar.js";
import type { LoadedHarness } from "../../harness/loader.js";
import { DEFAULT_PORT } from "../../server/index.js";

interface Props {
  harness: LoadedHarness;
  sessionId: string;
  onBack: () => void;
}

type Status = "idle" | "thinking" | "tool_calling" | "streaming" | "error";

// ── Proper SSE parser ─────────────────────────────────────────────────────────

function parseSseChunk(
  buffer: string,
  chunk: string
): { buffer: string; events: Array<{ type: string; data: unknown }> } {
  const updated = buffer + chunk;
  const lines = updated.split("\n");
  const remaining = lines.pop() ?? "";
  const events: Array<{ type: string; data: unknown }> = [];

  let currentEvent = "";
  for (const line of lines) {
    if (line.startsWith("event: ")) {
      currentEvent = line.slice(7).trim();
    } else if (line.startsWith("data: ")) {
      const rawData = line.slice(6);
      try {
        events.push({ type: currentEvent, data: JSON.parse(rawData) });
      } catch {
        events.push({ type: currentEvent, data: rawData });
      }
      currentEvent = "";
    } else if (line === "") {
      currentEvent = "";
    }
  }

  return { buffer: remaining, events };
}

// ── Component ─────────────────────────────────────────────────────────────────

export function Chat({ harness, sessionId, onBack }: Props) {
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;
  const height = stdout?.rows ?? 24;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [toolCalls, setToolCalls] = useState<ToolCallItem[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [streamingContent, setStreamingContent] = useState("");
  const streamingMsgId = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Load history on mount
  useEffect(() => {
    fetch(`http://localhost:${DEFAULT_PORT}/api/sessions/${sessionId}/history`)
      .then((r) => r.json())
      .then((data: unknown) => {
        const { messages: msgs } = data as {
          messages: Array<{ id: string; role: string; content: string; timestamp: number }>;
        };
        setMessages(
          msgs
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => ({
              id: m.id,
              role: m.role as "user" | "assistant",
              content: m.content,
              timestamp: m.timestamp,
            }))
        );
      })
      .catch(() => {});
  }, [sessionId]);

  useInput((inputChar, key) => {
    if (key.escape || (key.ctrl && inputChar === "b")) {
      if (status !== "idle") {
        abortRef.current?.abort();
        setStatus("idle");
        setStreamingContent("");
        setToolCalls([]);
        return;
      }
      onBack();
    }
  });

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || status !== "idle") return;
    setInput("");

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setStatus("thinking");
    setToolCalls([]);

    const assistantId = crypto.randomUUID();
    streamingMsgId.current = assistantId;
    setStreamingContent("");

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(
        `http://localhost:${DEFAULT_PORT}/api/sessions/${sessionId}/chat`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: text }),
          signal: controller.signal,
        }
      );

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";

      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;

        const { buffer, events } = parseSseChunk(sseBuffer, decoder.decode(value, { stream: true }));
        sseBuffer = buffer;

        for (const { type, data } of events) {
          const d = data as Record<string, unknown>;
          switch (type) {
            case "thinking":
              setStatus("thinking");
              break;

            case "tool_call":
              setStatus("tool_calling");
              setToolCalls((prev) => [
                ...prev,
                {
                  id: d.id as string,
                  name: d.name as string,
                  args: d.args as string,
                  status: "running",
                },
              ]);
              break;

            case "tool_result":
              setToolCalls((prev) =>
                prev.map((tc) =>
                  tc.id === (d.id as string)
                    ? {
                        ...tc,
                        output: d.output as string,
                        isError: d.isError as boolean,
                        status: (d.isError ? "error" : "done") as ToolCallItem["status"],
                      }
                    : tc
                )
              );
              break;

            case "delta":
              setStatus("streaming");
              setStreamingContent((prev) => prev + ((d.text as string) ?? ""));
              break;

            case "done":
              setMessages((prev) => [
                ...prev,
                {
                  id: assistantId,
                  role: "assistant" as const,
                  content: d.content as string,
                  timestamp: Date.now(),
                },
              ]);
              setStreamingContent("");
              setToolCalls([]);
              setStatus("idle");
              break;

            case "error":
              setMessages((prev) => [
                ...prev,
                {
                  id: assistantId,
                  role: "system" as const,
                  content: `Error: ${d.message}`,
                  timestamp: Date.now(),
                },
              ]);
              setStreamingContent("");
              setToolCalls([]);
              setStatus("error");
              setTimeout(() => setStatus("idle"), 2000);
              break;
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setStatus("error");
        setToolCalls([]);
        setTimeout(() => setStatus("idle"), 2000);
      } else {
        setStatus("idle");
        setToolCalls([]);
      }
    }
  }, [input, status, sessionId]);

  const displayMessages: ChatMessage[] = [
    ...messages,
    ...(streamingContent
      ? [
          {
            id: streamingMsgId.current ?? "streaming",
            role: "assistant" as const,
            content: streamingContent,
            timestamp: Date.now(),
            streaming: true,
          },
        ]
      : []),
  ];

  const statusLabel: Record<Status, string> =
    { idle: "ready", thinking: "thinking…", tool_calling: "calling tools…", streaming: "streaming…", error: "error" };

  return (
    <Box flexDirection="column" height={height}>
      <Box borderStyle="single" borderBottom paddingX={1}>
        <Text bold color="cyan">{harness.name}</Text>
        <Text dimColor>  Esc to go back • Ctrl+C to quit</Text>
      </Box>

      <Box flexGrow={1} flexDirection="column" paddingX={1} paddingTop={1} overflow="hidden">
        {displayMessages.length === 0 && toolCalls.length === 0 ? (
          <Box flexGrow={1} alignItems="center" justifyContent="center">
            <Text dimColor>{harness.config.description ?? `Chat with ${harness.name}`}</Text>
          </Box>
        ) : (
          <MessageList
            messages={displayMessages}
            toolCalls={toolCalls}
            maxHeight={height - 6}
          />
        )}
      </Box>

      <Box borderStyle="single" borderTop paddingX={1}>
        <Text color="cyan">❯ </Text>
        <Box flexGrow={1}>
          {status === "idle" ? (
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={sendMessage}
              placeholder="Type a message…"
            />
          ) : (
            <Text dimColor>{statusLabel[status]}</Text>
          )}
        </Box>
      </Box>

      <StatusBar
        harnessName={harness.name}
        sessionId={sessionId}
        status={status === "tool_calling" ? "streaming" : status}
        provider={`${harness.config.provider.type}${harness.config.provider.model ? `/${harness.config.provider.model}` : ""}`}
        width={width}
      />
    </Box>
  );
}
