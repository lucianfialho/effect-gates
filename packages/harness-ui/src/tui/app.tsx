import React, { useState, useEffect } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { HarnessSelect } from "./screens/harness-select.js";
import { Chat } from "./screens/chat.js";
import type { LoadedHarness } from "../harness/loader.js";
import { DEFAULT_PORT } from "../server/index.js";

type Screen = "loading" | "select" | "chat";

interface Props {
  harnesses: LoadedHarness[];
}

export function App({ harnesses }: Props) {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>("select");
  const [selectedHarness, setSelectedHarness] = useState<LoadedHarness | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useInput((input, key) => {
    if ((key.ctrl && input === "c") || input === "q") {
      if (screen === "select") exit();
    }
  });

  const handleSelectHarness = async (harness: LoadedHarness) => {
    setScreen("loading");
    setError(null);
    try {
      const res = await fetch(`http://localhost:${DEFAULT_PORT}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ harnessName: harness.name }),
      });
      const { sessionId: id } = await res.json() as { sessionId: string };
      setSelectedHarness(harness);
      setSessionId(id);
      setScreen("chat");
    } catch (e) {
      setError(`Failed to create session: ${e}`);
      setScreen("select");
    }
  };

  const handleBack = () => {
    setScreen("select");
    setSelectedHarness(null);
    setSessionId(null);
  };

  if (screen === "loading") {
    return (
      <Box padding={2}>
        <Text color="cyan">◆ </Text>
        <Text>Starting session…</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box padding={2} flexDirection="column">
        <Text color="red">Error: {error}</Text>
        <Text dimColor>Press any key to continue</Text>
      </Box>
    );
  }

  if (screen === "select") {
    return <HarnessSelect harnesses={harnesses} onSelect={handleSelectHarness} />;
  }

  if (screen === "chat" && selectedHarness && sessionId) {
    return (
      <Chat
        harness={selectedHarness}
        sessionId={sessionId}
        onBack={handleBack}
      />
    );
  }

  return null;
}
