import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type ClaudeCliAuth = {
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
const LOG_PATH = process.env.OPENCODE_CLAUDE_CLI_LOG_PATH || "/tmp/opencode-claude-cli.log";
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

export function isClaudeCliEnabled(): boolean {
  const value = trim(process.env.OPENCODE_CLAUDE_CLI_ENABLE).toLowerCase();
  const enabled = ["1", "true", "yes", "on"].includes(value);
  debugLog("isClaudeCliEnabled", { enabled, value });
  return enabled;
}

export function createClaudeCliAuth(): ClaudeCliAuth {
  return {
    type: "oauth",
    refresh: AUTH_MARKER,
    access: AUTH_MARKER,
    expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
  };
}

export function createClaudeCliCredentials() {
  return {
    type: "success" as const,
    refresh: AUTH_MARKER,
    access: AUTH_MARKER,
    expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
  };
}

export function isClaudeCliAuth(value: unknown): value is ClaudeCliAuth {
  if (!value || typeof value !== "object") return false;
  const auth = value as Partial<ClaudeCliAuth>;
  return auth.type === "oauth" && auth.refresh === AUTH_MARKER;
}

function getClaudePath(): string {
  return trim(process.env.OPENCODE_CLAUDE_CLI_PATH) || "claude";
}

function getPermissionArgs(): string[] {
  const dangerous = trim(process.env.OPENCODE_CLAUDE_CLI_DANGEROUSLY_SKIP_PERMISSIONS).toLowerCase();
  if (["1", "true", "yes", "on"].includes(dangerous)) {
    return ["--dangerously-skip-permissions"];
  }

  const args: string[] = [];
  const mode = trim(process.env.OPENCODE_CLAUDE_CLI_PERMISSION_MODE);
  if (mode) args.push("--permission-mode", mode);

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

function buildPrompt(request: AnthropicRequest): string {
  const parts = [
    "You are running behind the OpenCode UI, but all execution must happen through Claude Code's own local CLI harness.",
    "Work in the current working directory. Use Claude Code tools normally when needed.",
  ];

  const system = formatSystem(request.system);
  if (system) parts.push(`SYSTEM:\n${system}`);

  const transcript = formatMessages(request.messages);
  if (transcript) parts.push(`CONVERSATION:\n${transcript}`);

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

function inferCwd(init?: RequestInit): string {
  const headers = new Headers(init?.headers);
  return headers.get("x-opencode-cwd") || process.cwd();
}

function inferModel(request: AnthropicRequest): string {
  return trim(request.model) || trim(process.env.OPENCODE_CLAUDE_CLI_MODEL) || "claude-sonnet-4-6";
}

function makeArgs(request: AnthropicRequest): string[] {
  const outputFormat = request.stream ? "stream-json" : "json";
  const args = ["-p", buildPrompt(request), "--output-format", outputFormat];
  if (request.stream) args.push("--verbose");
  args.push("--model", inferModel(request));

  const maxTurns = trim(process.env.OPENCODE_CLAUDE_CLI_MAX_TURNS);
  if (maxTurns) args.push("--max-turns", maxTurns);

  const appendSystemPrompt = trim(process.env.OPENCODE_CLAUDE_CLI_APPEND_SYSTEM_PROMPT);
  if (appendSystemPrompt) args.push("--append-system-prompt", appendSystemPrompt);

  args.push(...getPermissionArgs());
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

async function runClaude(request: AnthropicRequest, cwd: string): Promise<ClaudeJsonResult> {
  const command = getClaudePath();
  const args = makeArgs(request);
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
      debugLog("runClaude:error", { message: error.message });
      reject(error);
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

function usage(result: ClaudeJsonResult) {
  return {
    input_tokens: result.usage?.input_tokens ?? 0,
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

function formatToolUseText(name?: string, input?: unknown): string {
  const toolName = trim(name) || "unknown";
  if (!input || typeof input !== "object") return `[Claude Code used ${toolName}]`;

  const record = input as Record<string, unknown>;
  const target = trim(record.file_path) || trim(record.filePath) || trim(record.description) || trim(record.command);
  return target ? `[Claude Code used ${toolName}: ${target}]` : `[Claude Code used ${toolName}]`;
}

function createSSEHeaders() {
  return {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  };
}

function streamResponseFromClaude(stdout: string, model: string): Response {
  const events = parseJsonLines(stdout);
  const resultEvent = [...events].reverse().find((event) => event.type === "result");
  const output = usage({ usage: resultEvent?.usage });
  const messageId = makeMessageId(resultEvent?.session_id);
  const chunks: string[] = [
    sse("message_start", {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: output.input_tokens, output_tokens: 0 },
      },
    }),
  ];

  let index = 0;
  const seenToolUse = new Set<string>();
  const emitTextBlock = (text: string) => {
    if (!text.trim()) return;
    chunks.push(
      sse("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      }),
      sse("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text },
      }),
      sse("content_block_stop", { type: "content_block_stop", index }),
    );
    index += 1;
  };

  for (const event of events) {
    if (event.type !== "assistant") continue;
    for (const part of event.message?.content || []) {
      if (part?.type === "tool_use") {
        const key = part.id || `${part.name}:${safeJson(part.input)}`;
        if (seenToolUse.has(key)) continue;
        seenToolUse.add(key);
        emitTextBlock(`${formatToolUseText(part.name, part.input)}\n`);
        continue;
      }

      if (part?.type === "text" && typeof part.text === "string" && part.text) {
        emitTextBlock(part.text);
      }
    }
  }

  if (index === 0) {
    emitTextBlock(normalizeClaudeOutput(events).result ?? "");
  }

  chunks.push(
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: output.output_tokens },
    }),
    sse("message_stop", { type: "message_stop" }),
  );

  return new Response(chunks.join(""), {
    status: 200,
    headers: createSSEHeaders(),
  });
}

function liveStreamResponse(request: AnthropicRequest, cwd: string, model: string): Response {
  const command = getClaudePath();
  const args = makeArgs(request);
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
            usage: { input_tokens: lastUsage?.input_tokens ?? 0, output_tokens: 0 },
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
        if (event.session_id) sessionId = event.session_id;
        if (event.usage) lastUsage = event.usage;

        if (event.type === "assistant") {
          for (const part of event.message?.content || []) {
            if (part?.type === "tool_use") {
              const key = part.id || `${part.name}:${safeJson(part.input)}`;
              if (seenToolUse.has(key)) continue;
              seenToolUse.add(key);
              emitTextBlock(`${formatToolUseText(part.name, part.input)}\n`);
              continue;
            }

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
        debugLog("runClaude:stream:error", { message: error.message });
        controller.error(error);
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
    const request = await parseRequest(input, init);
    const cwd = inferCwd(init);
    const model = inferModel(request);
    debugLog("handleClaudeCliFetch", { cwd, model, stream: !!request.stream });

    if (request.stream) {
      return liveStreamResponse(request, cwd, model);
    }

    const result = await runClaude(request, cwd);
    return jsonResponse(result, model);
  } catch (error) {
    debugLog("handleClaudeCliFetch:error", { message: error instanceof Error ? error.message : String(error) });
    return errorResponse(error);
  }
}
