import type { Plugin, PluginInput, PluginModule } from "@opencode-ai/plugin";
import {
  createClaudeCliCredentials,
  debugLog,
  ensureClaudeCliLoggedIn,
  handleClaudeCliFetch,
  isClaudeCliAuth,
} from "./claude-cli.js";

const CLAUDE_CLI_PROVIDER_ID = "claude-code-cli";
const CLAUDE_CLI_PROVIDER_NAME = "Claude Code";

function createModel(id: string, name: string) {
  return {
    id,
    providerID: CLAUDE_CLI_PROVIDER_ID,
    api: {
      id: "anthropic",
      url: "https://claude.ai/code",
      npm: "@ai-sdk/anthropic",
    },
    name,
    family: "claude",
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: {
        text: true,
        audio: false,
        image: true,
        video: false,
        pdf: true,
      },
      output: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
      interleaved: false,
    },
    cost: {
      input: 0,
      output: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
    limit: {
      context: 200_000,
      output: 8_192,
    },
    status: "active" as const,
    options: {},
    headers: {},
    release_date: "2026-04-09",
  };
}

function createModelMap() {
  return {
    "claude-opus-4-6": createModel("claude-opus-4-6", "Claude Opus 4.6"),
    "claude-sonnet-4-6": createModel("claude-sonnet-4-6", "Claude Sonnet 4.6"),
    "claude-haiku-4-5": createModel("claude-haiku-4-5", "Claude Haiku 4.5"),
    opus: createModel("opus", "Claude Opus (latest alias)"),
    sonnet: createModel("sonnet", "Claude Sonnet (latest alias)"),
    haiku: createModel("haiku", "Claude Haiku (latest alias)"),
  };
}

function applyProviderConfig(config: any) {
  config.provider ||= {};
  config.provider[CLAUDE_CLI_PROVIDER_ID] ||= {};

  const provider = config.provider[CLAUDE_CLI_PROVIDER_ID];
  provider.name ||= CLAUDE_CLI_PROVIDER_NAME;
  provider.npm ||= "@ai-sdk/anthropic";
  provider.options ||= {};
  provider.models = {
    ...createModelMap(),
    ...(provider.models || {}),
  };
}

export const server: Plugin = async (input: PluginInput) => {
  debugLog("plugin:server:init", {
    directory: input.directory,
    worktree: input.worktree,
    serverUrl: String(input.serverUrl),
  });

  return {
    config: async (config: any) => {
      applyProviderConfig(config);
      debugLog("hook:config", {
        providerID: CLAUDE_CLI_PROVIDER_ID,
        modelCount: Object.keys(config.provider?.[CLAUDE_CLI_PROVIDER_ID]?.models || {}).length,
      });
    },
    "chat.headers": async (input: any, output: any) => {
      if (input?.sessionID) {
        output.headers["x-opencode-session-id"] = input.sessionID;
      }
      if (input?.message?.id) {
        output.headers["x-opencode-message-id"] = input.message.id;
      }
    },
    "experimental.chat.system.transform": async (input: any, output: any) => {
      debugLog("hook:experimental.chat.system.transform", {
        providerID: input?.model?.providerID,
        modelID: input?.model?.id,
      });
      const prefix = "You are Claude Code, Anthropic's official CLI for Claude.";
      if (input.model?.providerID === CLAUDE_CLI_PROVIDER_ID) {
        output.system.unshift(prefix);
        if (output.system[1]) {
          output.system[1] = `${prefix}\n\n${output.system[1]}`;
        }
      }
    },
    provider: {
      id: CLAUDE_CLI_PROVIDER_ID,
      models: async () => createModelMap(),
    } as any,
    auth: {
      provider: CLAUDE_CLI_PROVIDER_ID,
      loader: (async (getAuth: () => Promise<unknown>, provider: any) => {
        const auth = await getAuth().catch(() => undefined);
        const modelEntries = provider?.models && typeof provider.models === "object"
          ? Object.values(provider.models)
          : [];

        debugLog("auth.loader", {
          auth: isClaudeCliAuth(auth) ? "claude-cli" : typeof auth,
          providerID: provider?.id,
          providerName: provider?.name,
          hasProvider: !!provider,
          modelCount: modelEntries.length,
        });
        if (!isClaudeCliAuth(auth)) return {};

        debugLog("auth.loader:activated", {
          providerID: provider?.id,
          modelCount: modelEntries.length,
        });

        for (const model of modelEntries as Array<any>) {
          model.cost = {
            input: 0,
            output: 0,
            cache: {
              read: 0,
              write: 0,
            },
          };
        }

        return {
          apiKey: "",
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            debugLog("auth.fetch:intercept", {
              providerID: provider?.id,
            });
            return handleClaudeCliFetch(input, init);
          },
        };
      }) as any,
      methods: [
        {
          label: CLAUDE_CLI_PROVIDER_NAME,
          type: "oauth",
          authorize: async () => {
            debugLog("auth.method.authorize");
            await ensureClaudeCliLoggedIn();
            return {
              url: "https://claude.ai/code",
              instructions: "Uses your local Claude Code login. No authorization code is needed here. If Claude Code is already logged in, press enter to activate. Otherwise run: claude auth login",
              method: "auto" as const,
              callback: async () => {
                debugLog("auth.method.callback");
                await ensureClaudeCliLoggedIn();
                return {
                  ...createClaudeCliCredentials(),
                  provider: CLAUDE_CLI_PROVIDER_ID,
                };
              },
            };
          },
        },
      ],
    },
  };
};

const plugin: PluginModule = {
  id: "opencode-claude-cli",
  server,
};

export default plugin;
