import React, { useState, useCallback, useEffect, useRef } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { MessageList, type ChatMessage } from "../components/message-list.js";
import { StatusBar } from "../components/status-bar.js";
import type { LoadedHarness } from "../../harness/loader.js";
import { DEFAULT_PORT } from "../../server/index.js";

interface Props {
  harness: LoadedHarness;
  sessionId: string;
  onBack: () => void;
}

type Status = "idle" | "thinking" | "streaming" | "error";

export function Chat({ harness, sessionId, onBack }: Props) {
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;
  const height = stdout?.rows ?? 24;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
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
        const { messages: msgs } = data as { messages: Array<{ id: string; role: string; content: string; timestamp: number }> };
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
      if (status === "streaming" || status === "thinking") {
        abortRef.current?.abort();
        setStatus("idle");
        setStreamingContent("");
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
      let accumulated = "";

      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            // handled below
          } else if (line.startsWith("data: ")) {
            const eventLine = lines[lines.indexOf(line) - 1] ?? "";
            const eventType = eventLine.replace("event: ", "").trim();
            const data = JSON.parse(line.replace("data: ", ""));

            if (eventType === "thinking") {
              setStatus("thinking");
            } else if (eventType === "delta") {
              setStatus("streaming");
              accumulated += data.text ?? "";
              setStreamingContent(accumulated);
            } else if (eventType === "done") {
              setMessages((prev) => [
                ...prev,
                {
                  id: assistantId,
                  role: "assistant",
                  content: data.content,
                  timestamp: Date.now(),
                },
              ]);
              setStreamingContent("");
              setStatus("idle");
            } else if (eventType === "error") {
              setMessages((prev) => [
                ...prev,
                {
                  id: assistantId,
                  role: "system",
                  content: `Error: ${data.message}`,
                  timestamp: Date.now(),
                },
              ]);
              setStatus("error");
              setTimeout(() => setStatus("idle"), 2000);
            }
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setStatus("error");
        setTimeout(() => setStatus("idle"), 2000);
      } else {
        setStatus("idle");
      }
    }
  }, [input, status, sessionId]);

  const displayMessages = [
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

  return (
    <Box flexDirection="column" height={height}>
      {/* Header */}
      <Box borderStyle="single" borderBottom paddingX={1}>
        <Text bold color="cyan">{harness.name}</Text>
        <Text dimColor>  Esc/Ctrl+B to go back</Text>
      </Box>

      {/* Messages */}
      <Box flexGrow={1} flexDirection="column" paddingX={1} paddingTop={1} overflow="hidden">
        {displayMessages.length === 0 ? (
          <Box flexGrow={1} alignItems="center" justifyContent="center">
            <Text dimColor>
              {harness.config.description ?? `Chat with ${harness.name}`}
            </Text>
          </Box>
        ) : (
          <MessageList messages={displayMessages} maxHeight={height - 6} />
        )}
      </Box>

      {/* Input */}
      <Box borderStyle="single" borderTop paddingX={1} paddingY={0}>
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
            <Text dimColor>
              {status === "thinking" ? "Thinking…" : status === "streaming" ? "Receiving…" : "Error"}
            </Text>
          )}
        </Box>
      </Box>

      {/* Status bar */}
      <StatusBar
        harnessName={harness.name}
        sessionId={sessionId}
        status={status}
        provider={`${harness.config.provider.type}${harness.config.provider.model ? `/${harness.config.provider.model}` : ""}`}
        width={width}
      />
    </Box>
  );
}
