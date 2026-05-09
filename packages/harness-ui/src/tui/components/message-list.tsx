import React from "react";
import { Box, Text } from "ink";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  streaming?: boolean;
}

interface Props {
  messages: ChatMessage[];
  maxHeight: number;
}

export function MessageList({ messages, maxHeight }: Props) {
  const visible = messages.slice(-Math.floor(maxHeight / 3));

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {visible.map((msg) => (
        <Box key={msg.id} flexDirection="column" marginBottom={1}>
          <Box>
            <Text
              bold
              color={msg.role === "user" ? "cyan" : msg.role === "assistant" ? "green" : "yellow"}
            >
              {msg.role === "user" ? "You" : msg.role === "assistant" ? "Agent" : "System"}
            </Text>
            <Text dimColor>
              {" "}
              {new Date(msg.timestamp).toLocaleTimeString("pt-BR", {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </Text>
            {msg.streaming && <Text color="yellow"> ●</Text>}
          </Box>
          <Box paddingLeft={2}>
            <Text wrap="wrap">{msg.content}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}
