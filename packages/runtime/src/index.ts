export { SessionHistory, makeInMemorySessionStore } from "./session-history.js";
export type { SessionData, MessageEntry, CompactionEntry, BranchSummaryEntry, Message, MessageRole, SessionEntryType, SessionStore } from "./session-history.js";

export { makeFileSessionStore, listSessions } from "./file-session-store.js";

export {
  createCompactionTrigger,
  runCompaction,
  withCompaction,
  defaultCompactionConfig,
} from "./compaction.js";
export type { CompactionConfig, CompactionResult, CompactionError } from "./compaction.js";

export {
  makeTokenBudgetTracker,
  defaultTokenBudgetConfig,
  estimateTokens,
  estimateMessagesTokensCount,
} from "./token-budget.js";
export type { TokenBudget, TokenBudgetConfig } from "./token-budget.js";

export { makeAgent } from "./runtime.js";
export type {
  Agent,
  AgentResponse,
  AgentError,
  AgentConfig,
  Provider,
  ChatResponse,
  ProviderError,
  Session,
} from "./runtime.js";

export {
  makeReadTool,
  makeWriteTool,
  makeBashTool,
  makeGlobTool,
  makeGrepTool,
  makeEditTool,
  listTools,
  toolsMap,
} from "./builtin-tools.js";
export type { Tool, ToolCall, ToolResult } from "./tools.js";
export { toolResult, toolError, makeToolCall } from "./tools.js";

export { runAgentLoop } from "./agent-loop.js";
export type { AgentLoopConfig, AgentLoopResult, ProviderResponse } from "./agent-loop.js";

export { defineCommand } from "./define-command.js";
export type { CommandConfig } from "./define-command.js";

export { makePatchTool, applyPatch } from "./patch.js";
export type { PatchResult } from "./patch.js";

export {
  createHarness,
  defineHarness,
  runHarness,
  skill,
  role,
  parseResultSchema,
  createSkillResultSchema,
} from "./harness.js";
export type {
  FunctionalHarnessDef,
  HarnessContext,
  HarnessInitOptions,
  HarnessSession,
  HarnessResponse,
  HarnessError,
  SkillOptions,
  SkillResultSchema,
  CompactionScope,
  Role,
  Trigger,
  HarnessConfig,
  HarnessRegistry,
  SkillDefinition,
} from "./harness.js";

export { createHarnessRegistry } from "./harness-registry.js";

export {
  makeAgentEvents,
  streamTextDelta,
  createEventFilter,
  mergeEvents,
} from "./events.js";
export type {
  AgentEventType,
  AgentEvent,
  AgentEvents,
} from "./events.js";

export {
  createTelemetryPlugin,
  composeTelemetryPlugins,
  withTelemetry,
  withToolTelemetry,
  withSpan,
  createSpan,
} from "./telemetry.js";
export type {
  TelemetryPlugin,
  AgentEventHandlers,
} from "./telemetry.js";

export {
  eventToSSE,
  formatSSE,
  eventToSSELines,
  streamToSSE,
  eventsToSSEStream,
  parseSSELine,
  parseSSEData,
  combineEvents,
  filterEventsByType,
  mapEventData,
  writeSSELines,
  createSSEPublisher,
  createSSEStream,
} from "./streaming.js";
export type { SSEMessage, SSEHandler } from "./streaming.js";