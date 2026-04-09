import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type ClaudeCliAuth = {
  type: "oauth";
  refresh: string;
  access?: string;
  expires: number;
};

type AnthropicContentBlock = {
  type?: string;
  text?: string;
  name?: string;
  content?: unknown;
};

type AnthropicMessage = {
  role?: string;
  content?: string | AnthropicContentBlock[];
};

type AnthropicRequest = {
  model?: string;
  system?: string | Array<{ type?: string; text?: string }>;
  messages?: AnthropicMessage[];
  stream?: boolean;
  tools?: Array<{ name?: string }>;
};

type ClaudeJsonResult = {
  result?: string;
  session_id?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
};

type ClaudeJsonEvent = {
  type?: string;
  subtype?: string;
  result?: string;
  session_id?: string;
  usage?: ClaudeJsonResult["usage"];
  event?: {
    type?: string;
    index?: number;
    message?: {
      usage?: ClaudeJsonResult["usage"];
    };
    content_block?: {
      type?: string;
      id?: string;
      name?: string;
      input?: unknown;
      text?: string;
    };
    delta?: {
      type?: string;
      text?: string;
      partial_json?: string;
    };
    usage?: ClaudeJsonResult["usage"];
  };
  message?: {
    id?: string;
    content?: Array<{
      type?: string;
      text?: string;
      id?: string;
      name?: string;
      input?: unknown;
    }>;
  };
  content?: Array<{ type?: string; text?: string }>;
  text?: string;
  tool_use_result?: {
    stdout?: string;
    stderr?: string;
    interrupted?: boolean;
  };
};

const AUTH_MARKER = "__claude_cli_local__";

function defaultStateDir(): string {
  const home = trim(process.env.HOME);
  if (trim(process.env.XDG_STATE_HOME)) return join(trim(process.env.XDG_STATE_HOME), "opencode-claude-cli");
  if (process.platform === "darwin" && home) return join(home, "Library", "Application Support", "opencode-claude-cli");
  if (home) return join(home, ".local", "state", "opencode-claude-cli");
  return "/tmp/opencode-claude-cli";
}

const STATE_DIR = defaultStateDir();
const LOG_PATH = process.env.OPENCODE_CLAUDE_CLI_LOG_PATH || join(STATE_DIR, "plugin.log");
const SESSION_MAP_PATH = process.env.OPENCODE_CLAUDE_CLI_SESSION_MAP_PATH || join(STATE_DIR, "sessions.json");
const DEFAULT_ALLOWED_TOOLS = [
  "Read",
  "Edit",
  "Write",
  "Bash",
  "Grep",
  "Glob",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
];

function trim(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function debugLog(message: string, extra?: unknown): void {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    const line = `[${new Date().toISOString()}] ${message}${typeof extra === "undefined" ? "" : ` ${safeJson(extra)}`}\n`;
    appendFileSync(LOG_PATH, line, "utf8");
  } catch {}
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatClaudeCliError(error: unknown): Error {
  if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
    return new Error("Claude Code was not found on PATH. Install the `claude` CLI or set OPENCODE_CLAUDE_CLI_PATH.");
  }
  if (error instanceof Error) return error;
  return new Error(String(error));
}

export function createClaudeCliCredentials() {
  return {
    type: "success" as const,
    refresh: AUTH_MARKER,
    access: AUTH_MARKER,
    expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
  };
}

export async function getClaudeAuthStatus(): Promise<{ loggedIn: boolean; raw?: unknown }> {
  const command = getClaudePath();

  return await new Promise((resolve, reject) => {
    const child = spawn(command, ["auth", "status"], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.once("error", (error) => reject(formatClaudeCliError(error)));
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `claude auth status exited with code ${code}`));
        return;
      }

      try {
        const parsed = JSON.parse(stdout);
        resolve({
          loggedIn: !!parsed?.loggedIn,
          raw: parsed,
        });
      } catch (error) {
        reject(new Error(`Failed to parse claude auth status output: ${stdout.slice(0, 500)}\n${String(error)}`));
      }
    });
  });
}

export async function ensureClaudeCliLoggedIn(): Promise<void> {
  const status = await getClaudeAuthStatus();
  debugLog("claude.auth.status", status.raw);
  if (!status.loggedIn) {
    throw new Error("Claude Code is not logged in. Run `claude auth login` and try again.");
  }
}

export function isClaudeCliAuth(value: unknown): value is ClaudeCliAuth {
  if (!value || typeof value !== "object") return false;
  const auth = value as Partial<ClaudeCliAuth>;
  return auth.type === "oauth" && auth.refresh === AUTH_MARKER;
}

function getClaudePath(): string {
  return trim(process.env.OPENCODE_CLAUDE_CLI_PATH) || "claude";
}

function detectOpenCodePlanMode(request: AnthropicRequest): boolean {
  const haystack = [
    formatSystem(request.system),
    formatMessages(request.messages),
  ].join("\n\n").toLowerCase();

  return haystack.includes("plan mode active")
    || haystack.includes("you are in read-only phase")
    || haystack.includes("strictly forbidden")
    || haystack.includes("must not make edits");
}

function getPermissionArgs(request: AnthropicRequest): string[] {
  const args: string[] = ["--dangerously-skip-permissions"];

  if (detectOpenCodePlanMode(request)) {
    args.push("--permission-mode", "plan");
  }

  const allowedTools = trim(process.env.OPENCODE_CLAUDE_CLI_ALLOWED_TOOLS) || DEFAULT_ALLOWED_TOOLS.join(",");
  args.push("--allowedTools", allowedTools);
  return args;
}

function flattenText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flattenText).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";

  const block = value as AnthropicContentBlock;
  if (block.type === "text") return trim(block.text);
  if (block.type === "tool_result") return flattenText(block.content);
  if (block.type === "tool_use") return `[tool_use ${trim(block.name) || "unknown"}]`;
  if ("text" in block && typeof block.text === "string") return block.text;
  if ("content" in block) return flattenText(block.content);
  return "";
}

function formatSystem(system: AnthropicRequest["system"]): string {
  if (typeof system === "string") return system.trim();
  if (!Array.isArray(system)) return "";
  return system
    .map((item) => (item?.type === "text" ? trim(item.text) : ""))
    .filter(Boolean)
    .join("\n\n");
}

function formatMessages(messages: AnthropicRequest["messages"]): string {
  if (!Array.isArray(messages)) return "";
  return messages
    .map((message) => {
      const role = trim(message.role) || "user";
      const content = typeof message.content === "string" ? message.content : flattenText(message.content);
      return `${role.toUpperCase()}:\n${content.trim()}`.trim();
    })
    .filter(Boolean)
    .join("\n\n");
}

function getLatestUserMessage(messages: AnthropicRequest["messages"]): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (trim(message?.role) !== "user") continue;
    const content = typeof message.content === "string" ? message.content : flattenText(message.content);
    if (content.trim()) return content.trim();
  }
  return "";
}

function buildPrompt(request: AnthropicRequest, options?: { resumed?: boolean }): string {
  const parts = [
    "You are running behind the OpenCode UI, but all execution must happen through Claude Code's own local CLI harness.",
    "Work in the current working directory. Use Claude Code tools normally when needed.",
  ];

  const system = formatSystem(request.system);
  if (system) parts.push(`SYSTEM:\n${system}`);

  if (options?.resumed) {
    const latestUserMessage = getLatestUserMessage(request.messages);
    if (latestUserMessage) {
      parts.push(`LATEST USER MESSAGE:\n${latestUserMessage}`);
    }
  } else {
    const transcript = formatMessages(request.messages);
    if (transcript) parts.push(`CONVERSATION:\n${transcript}`);
  }

  if (Array.isArray(request.tools) && request.tools.length) {
    const tools = request.tools.map((tool) => trim(tool.name)).filter(Boolean).join(", ");
    if (tools) parts.push(`OpenCode exposed these logical tools: ${tools}. Use Claude Code's closest built-in tools as needed.`);
  }

  parts.push("Return only the answer for the user unless the task itself requires file changes or command output.");
  return parts.join("\n\n");
}

async function readBody(body: BodyInit | null | undefined): Promise<string> {
  if (!body) return "";
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ReadableStream) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let result = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
    return result;
  }
  return String(body);
}

async function parseRequest(input: RequestInfo | URL, init?: RequestInit): Promise<AnthropicRequest> {
  const bodyText = typeof init?.body !== "undefined"
    ? await readBody(init.body)
    : input instanceof Request
      ? await input.clone().text()
      : "";

  return bodyText ? (JSON.parse(bodyText) as AnthropicRequest) : {};
}

function inferHeaders(init?: RequestInit): Headers {
  return new Headers(init?.headers);
}

function inferCwd(init?: RequestInit): string {
  const headers = inferHeaders(init);
  return headers.get("x-opencode-cwd") || process.cwd();
}

function inferOpencodeSessionID(init?: RequestInit): string {
  const headers = inferHeaders(init);
  return trim(headers.get("x-opencode-session-id"));
}

function inferModel(request: AnthropicRequest): string {
  return trim(request.model) || trim(process.env.OPENCODE_CLAUDE_CLI_MODEL) || "claude-sonnet-4-6";
}

function loadSessionMap(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(SESSION_MAP_PATH, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function saveSessionMap(map: Record<string, string>): void {
  try {
    mkdirSync(dirname(SESSION_MAP_PATH), { recursive: true });
    writeFileSync(SESSION_MAP_PATH, JSON.stringify(map, null, 2), "utf8");
  } catch (error) {
    debugLog("sessionMap:save:error", { message: error instanceof Error ? error.message : String(error) });
  }
}

function shouldUseSessionBinding(request: AnthropicRequest): boolean {
  const system = formatSystem(request.system).toLowerCase();
  if (!system) return true;
  if (system.includes("you are a title generator")) return false;
  if (system.includes("generate a brief title")) return false;
  return true;
}

function getBoundClaudeSessionID(opencodeSessionID: string): string {
  if (!opencodeSessionID) return "";
  return trim(loadSessionMap()[opencodeSessionID]);
}

function bindClaudeSessionID(opencodeSessionID: string, claudeSessionID?: string): void {
  const cleanOpencode = trim(opencodeSessionID);
  const cleanClaude = trim(claudeSessionID);
  if (!cleanOpencode || !cleanClaude) return;
  const map = loadSessionMap();
  if (map[cleanOpencode] === cleanClaude) return;
  map[cleanOpencode] = cleanClaude;
  saveSessionMap(map);
  debugLog("sessionMap:bind", { opencodeSessionID: cleanOpencode, claudeSessionID: cleanClaude });
}

function makeArgs(request: AnthropicRequest, options?: { resumeSessionID?: string }): string[] {
  const outputFormat = request.stream ? "stream-json" : "json";
  const resumeSessionID = trim(options?.resumeSessionID);
  const args = ["-p", buildPrompt(request, { resumed: !!resumeSessionID }), "--output-format", outputFormat];
  if (resumeSessionID) args.push("--resume", resumeSessionID);
  if (request.stream) args.push("--verbose", "--include-partial-messages");
  args.push("--model", inferModel(request));

  const maxTurns = trim(process.env.OPENCODE_CLAUDE_CLI_MAX_TURNS);
  if (maxTurns) args.push("--max-turns", maxTurns);

  const appendSystemPrompt = trim(process.env.OPENCODE_CLAUDE_CLI_APPEND_SYSTEM_PROMPT);
  if (appendSystemPrompt) args.push("--append-system-prompt", appendSystemPrompt);

  args.push(...getPermissionArgs(request));
  return args;
}

function extractTextFromEvents(events: ClaudeJsonEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (typeof event.result === "string" && event.result.trim()) return event.result;

    const messageText = event.message?.content
      ?.filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text ?? "")
      .join("\n")
      .trim();
    if (messageText) return messageText;

    const contentText = event.content
      ?.filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text ?? "")
      .join("\n")
      .trim();
    if (contentText) return contentText;

    if (typeof event.text === "string" && event.text.trim()) return event.text;
  }
  return "";
}

function normalizeClaudeOutput(parsed: unknown): ClaudeJsonResult {
  if (Array.isArray(parsed)) {
    const events = parsed as ClaudeJsonEvent[];
    const resultEvent = [...events].reverse().find((event) => typeof event.result === "string") ?? events[events.length - 1];
    return {
      result: extractTextFromEvents(events),
      session_id: resultEvent?.session_id,
      usage: resultEvent?.usage,
    };
  }

  if (parsed && typeof parsed === "object") {
    return parsed as ClaudeJsonResult;
  }

  return { result: typeof parsed === "string" ? parsed : String(parsed ?? "") };
}

function parseJsonLines(stdout: string): ClaudeJsonEvent[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ClaudeJsonEvent);
}

async function runClaude(request: AnthropicRequest, cwd: string, options?: { resumeSessionID?: string }): Promise<ClaudeJsonResult> {
  const command = getClaudePath();
  const args = makeArgs(request, options);
  debugLog("runClaude:start", { command, args, cwd, model: inferModel(request) });

  return await new Promise<ClaudeJsonResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.once("error", (error) => {
      const normalized = formatClaudeCliError(error);
      debugLog("runClaude:error", { message: normalized.message });
      reject(normalized);
    });
    child.once("close", (code) => {
      debugLog("runClaude:close", { code, stderr: stderr.slice(0, 1000), stdout: stdout.slice(0, 1000) });
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `claude exited with code ${code}`));
        return;
      }

      try {
        resolve(normalizeClaudeOutput(JSON.parse(stdout)));
      } catch (error) {
        reject(new Error(`Failed to parse Claude Code output as JSON: ${stdout.slice(0, 1000)}\n${String(error)}`));
      }
    });
  });
}

function makeMessageId(sessionId?: string): string {
  const suffix = trim(sessionId) || crypto.randomUUID();
  return `msg_${suffix.replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

function effectiveInputTokens(usage?: ClaudeJsonResult["usage"]): number {
  return (usage?.input_tokens ?? 0)
    + (usage?.cache_read_input_tokens ?? 0)
    + (usage?.cache_creation_input_tokens ?? 0);
}

function usage(result: ClaudeJsonResult) {
  return {
    input_tokens: effectiveInputTokens(result.usage),
    output_tokens: result.usage?.output_tokens ?? 0,
    cache_read_input_tokens: result.usage?.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: result.usage?.cache_creation_input_tokens ?? 0,
  };
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function jsonResponse(result: ClaudeJsonResult, model: string): Response {
  return new Response(JSON.stringify({
    id: makeMessageId(result.session_id),
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: result.result ?? "" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: usage(result),
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function parseMaybeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function shortPath(value: string): string {
  const cwd = process.cwd().replace(/\\/g, "/");
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith(`${cwd}/`)) return normalized.slice(cwd.length + 1);
  return normalized;
}

function shouldDisplayToolUse(name?: string): boolean {
  const toolName = trim(name);
  return toolName !== "ExitPlanMode";
}

function formatToolUseText(name?: string, input?: unknown): string {
  const toolName = trim(name) || "unknown";
  if (!input || typeof input !== "object") return `✱ ${toolName}`;

  const record = input as Record<string, unknown>;
  const filePath = trim(record.file_path) || trim(record.filePath);
  if (filePath) return `✱ ${toolName} ${shortPath(filePath)}`;

  const command = trim(record.command);
  if (command) return `✱ ${toolName} ${command}`;

  const description = trim(record.description);
  if (description) return `✱ ${toolName} ${description}`;

  return `✱ ${toolName}`;
}

function createSSEHeaders() {
  return {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  };
}

function liveStreamResponse(
  request: AnthropicRequest,
  cwd: string,
  model: string,
  options?: { opencodeSessionID?: string; resumeSessionID?: string; shouldBindSession?: boolean },
): Response {
  const command = getClaudePath();
  const args = makeArgs(request, { resumeSessionID: options?.resumeSessionID });
  debugLog("runClaude:stream:start", { command, args, cwd, model });

  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const child = spawn(command, args, {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let buffer = "";
      let stderr = "";
      let messageStarted = false;
      let blockIndex = 0;
      let seenToolUse = new Set<string>();
      let lastUsage: ClaudeJsonResult["usage"] | undefined;
      let sessionId: string | undefined;
      let sawOutput = false;
      let sawStreamEvent = false;
      const textBlockMap = new Map<number, number>();
      const toolUseMap = new Map<number, { id?: string; name?: string; json: string; input?: unknown }>();

      const enqueue = (chunk: string) => controller.enqueue(encoder.encode(chunk));

      const ensureMessageStart = () => {
        if (messageStarted) return;
        messageStarted = true;
        enqueue(sse("message_start", {
          type: "message_start",
          message: {
            id: makeMessageId(sessionId),
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: effectiveInputTokens(lastUsage), output_tokens: 0 },
          },
        }));
      };

      const emitTextBlock = (text: string) => {
        if (!text.trim()) return;
        sawOutput = true;
        ensureMessageStart();
        enqueue(sse("content_block_start", {
          type: "content_block_start",
          index: blockIndex,
          content_block: { type: "text", text: "" },
        }));
        enqueue(sse("content_block_delta", {
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "text_delta", text },
        }));
        enqueue(sse("content_block_stop", { type: "content_block_stop", index: blockIndex }));
        blockIndex += 1;
      };

      const processEvent = (event: ClaudeJsonEvent) => {
        if (event.session_id) {
          sessionId = event.session_id;
          if (options?.shouldBindSession && options?.opencodeSessionID) {
            bindClaudeSessionID(options.opencodeSessionID, event.session_id);
          }
        }
        if (event.usage) lastUsage = event.usage;

        if (event.type === "stream_event" && event.event) {
          sawStreamEvent = true;
          const inner = event.event;
          if (inner.message?.usage) lastUsage = inner.message.usage;
          if (inner.usage) lastUsage = inner.usage;

          if (inner.type === "message_start") {
            ensureMessageStart();
            return;
          }

          if (inner.type === "content_block_start") {
            const sourceIndex = inner.index ?? -1;
            const block = inner.content_block;
            if (block?.type === "text") {
              ensureMessageStart();
              const targetIndex = blockIndex++;
              textBlockMap.set(sourceIndex, targetIndex);
              enqueue(sse("content_block_start", {
                type: "content_block_start",
                index: targetIndex,
                content_block: { type: "text", text: "" },
              }));
              return;
            }

            if (block?.type === "tool_use") {
              toolUseMap.set(sourceIndex, {
                id: block.id,
                name: block.name,
                json: "",
                input: block.input,
              });
            }
            return;
          }

          if (inner.type === "content_block_delta") {
            const sourceIndex = inner.index ?? -1;
            const delta = inner.delta;
            const textIndex = textBlockMap.get(sourceIndex);
            if (delta?.type === "text_delta" && typeof delta.text === "string" && typeof textIndex === "number") {
              sawOutput = true;
              enqueue(sse("content_block_delta", {
                type: "content_block_delta",
                index: textIndex,
                delta: { type: "text_delta", text: delta.text },
              }));
              return;
            }

            if (delta?.type === "input_json_delta") {
              const tool = toolUseMap.get(sourceIndex);
              if (tool) tool.json += delta.partial_json ?? "";
            }
            return;
          }

          if (inner.type === "content_block_stop") {
            const sourceIndex = inner.index ?? -1;
            const textIndex = textBlockMap.get(sourceIndex);
            if (typeof textIndex === "number") {
              enqueue(sse("content_block_stop", { type: "content_block_stop", index: textIndex }));
              textBlockMap.delete(sourceIndex);
              return;
            }

            const tool = toolUseMap.get(sourceIndex);
            if (tool) {
              const parsed = tool.input ?? parseMaybeJson(tool.json);
              const key = tool.id || `${tool.name}:${safeJson(parsed)}`;
              if (!seenToolUse.has(key)) {
                seenToolUse.add(key);
                if (shouldDisplayToolUse(tool.name)) {
                  emitTextBlock(`${formatToolUseText(tool.name, parsed)}\n`);
                }
              }
              toolUseMap.delete(sourceIndex);
            }
            return;
          }

          if (inner.type === "message_delta") {
            return;
          }

          if (inner.type === "message_stop") {
            return;
          }
        }

        if (event.type === "assistant") {
          for (const part of event.message?.content || []) {
            if (part?.type === "tool_use") {
              const key = part.id || `${part.name}:${safeJson(part.input)}`;
              if (seenToolUse.has(key)) continue;
              seenToolUse.add(key);
              if (shouldDisplayToolUse(part.name)) {
                emitTextBlock(`${formatToolUseText(part.name, part.input)}\n`);
              }
              continue;
            }

            if (sawStreamEvent) continue;

            if (part?.type === "text" && typeof part.text === "string" && part.text) {
              emitTextBlock(part.text);
            }
          }
          return;
        }

        if (event.type === "result") {
          ensureMessageStart();
          if (!sawOutput && typeof event.result === "string") {
            emitTextBlock(event.result);
          }
          for (const [, textIndex] of textBlockMap) {
            enqueue(sse("content_block_stop", { type: "content_block_stop", index: textIndex }));
          }
          textBlockMap.clear();
          enqueue(sse("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: event.usage?.output_tokens ?? 0 },
          }));
          enqueue(sse("message_stop", { type: "message_stop" }));
          controller.close();
        }
      };

      child.stdout.on("data", (chunk: Buffer | string) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            processEvent(JSON.parse(trimmed) as ClaudeJsonEvent);
          } catch (error) {
            debugLog("runClaude:stream:parse_error", { line: trimmed.slice(0, 500), error: String(error) });
          }
        }
      });

      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });

      child.once("error", (error) => {
        const normalized = formatClaudeCliError(error);
        debugLog("runClaude:stream:error", { message: normalized.message });
        controller.error(normalized);
      });

      child.once("close", (code) => {
        if (buffer.trim()) {
          try {
            processEvent(JSON.parse(buffer.trim()) as ClaudeJsonEvent);
          } catch (error) {
            debugLog("runClaude:stream:trailing_parse_error", { line: buffer.trim().slice(0, 500), error: String(error) });
          }
        }

        debugLog("runClaude:stream:close", { code, stderr: stderr.slice(0, 1000) });

        if (code !== 0) {
          controller.error(new Error(stderr.trim() || `claude exited with code ${code}`));
          return;
        }

        if (!messageStarted) {
          ensureMessageStart();
          enqueue(sse("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: lastUsage?.output_tokens ?? 0 },
          }));
          enqueue(sse("message_stop", { type: "message_stop" }));
          controller.close();
        }
      });
    },
  });

  return new Response(body, {
    status: 200,
    headers: createSSEHeaders(),
  });
}

function errorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  return new Response(JSON.stringify({
    type: "error",
    error: {
      type: "api_error",
      message,
    },
  }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
}

export async function handleClaudeCliFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try {
    await ensureClaudeCliLoggedIn();
    const request = await parseRequest(input, init);
    const cwd = inferCwd(init);
    const model = inferModel(request);
    const opencodeSessionID = inferOpencodeSessionID(init);
    const shouldBindSession = shouldUseSessionBinding(request) && !!opencodeSessionID;
    const resumeSessionID = shouldBindSession ? getBoundClaudeSessionID(opencodeSessionID) : "";

    debugLog("handleClaudeCliFetch", {
      cwd,
      model,
      stream: !!request.stream,
      opencodeSessionID,
      shouldBindSession,
      resumeSessionID,
    });

    if (request.stream) {
      return liveStreamResponse(request, cwd, model, { opencodeSessionID, resumeSessionID, shouldBindSession });
    }

    const result = await runClaude(request, cwd, { resumeSessionID });
    if (shouldBindSession) bindClaudeSessionID(opencodeSessionID, result.session_id);
    return jsonResponse(result, model);
  } catch (error) {
    debugLog("handleClaudeCliFetch:error", { message: error instanceof Error ? error.message : String(error) });
    return errorResponse(error);
  }
}
