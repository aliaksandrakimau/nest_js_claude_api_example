import type { CliState } from './store.js';
import {
  fetchModels,
  createSession,
  getSessionHistory,
  listPrompts,
} from './api.js';

export interface CommandResult {
  output: string;
  update?: Partial<CliState>;
  showModelPicker?: boolean;
}

export async function handleCommand(
  input: string,
  state: CliState,
): Promise<CommandResult> {
  const [command, ...args] = input.slice(1).trim().split(/\s+/);
  const arg = args.join(' ');

  switch (command) {
    case 'help':
      return {
        output: [
          'Commands:',
          '  /models           List available models',
          '  /model <id>       Switch model',
          '  /sessions         List sessions (shows current)',
          '  /new              Create new session',
          '  /use <id>         Switch to session',
          '  /history          Show current session history',
          '  /prompts          List saved prompts',
          '  /prompt <name>    Use prompt as system prompt',
          '  /system <text>    Set system prompt',
          '  /temp <0-1>       Set temperature',
          '  /maxTokens <n>    Set max tokens',
          '  /stream on|off    Toggle streaming',
          '  /help             Show this help',
          '  /quit             Exit',
        ].join('\n'),
      };

    case 'models':
      try {
        const models = await fetchModels(state.baseUrl);
        const lines = models.map(
          (m) => `  ${state.model === m.id ? '>' : ' '} ${m.id}`,
        );
        return {
          output: `Models (${models.length}):\n${lines.join('\n')}`,
          update: { models, modelsLoaded: true },
          showModelPicker: true,
        };
      } catch (e) {
        return { output: `Error: ${e instanceof Error ? e.message : e}` };
      }

    case 'model':
      if (!arg) {
        return { output: 'Usage: /model <model-id>' };
      }
      return {
        output: `Model switched to: ${arg}`,
        update: { model: arg },
      };

    case 'new':
      try {
        const sessionId = await createSession(state.baseUrl);
        return {
          output: `New session: ${sessionId}`,
          update: { sessionId },
        };
      } catch (e) {
        return { output: `Error: ${e instanceof Error ? e.message : e}` };
      }

    case 'use':
      if (!arg) {
        return { output: 'Usage: /use <session-id>' };
      }
      return {
        output: `Switched to session: ${arg}`,
        update: { sessionId: arg },
      };

    case 'sessions': {
      let info = `Current session: ${state.sessionId ?? 'none'}`;
      if (state.sessionId) {
        try {
          const hist = await getSessionHistory(state.baseUrl, state.sessionId);
          info += `\n  Messages: ${hist.messages.length}`;
        } catch {
          info += `\n  (session expired or not found)`;
        }
      }
      return { output: info };
    }

    case 'history': {
      if (!state.sessionId) {
        return { output: 'No active session' };
      }
      try {
        const hist = await getSessionHistory(state.baseUrl, state.sessionId);
        const lines = hist.messages.map(
          (m) => `  [${m.role}] ${m.content.slice(0, 120)}${m.content.length > 120 ? '...' : ''}`,
        );
        return { output: `History (${hist.messages.length} messages):\n${lines.join('\n')}` };
      } catch (e) {
        return { output: `Error: ${e instanceof Error ? e.message : e}` };
      }
    }

    case 'prompts': {
      try {
        const prompts = await listPrompts(state.baseUrl);
        if (prompts.length === 0) return { output: 'No saved prompts' };
        const lines = prompts.map(
          (p) => `  ${p.name} (v${p.version}) — ${p.text.slice(0, 60)}...`,
        );
        return { output: `Prompts (${prompts.length}):\n${lines.join('\n')}` };
      } catch (e) {
        return { output: `Error: ${e instanceof Error ? e.message : e}` };
      }
    }

    case 'prompt':
      if (!arg) {
        return { output: 'Usage: /prompt <name> — applies saved prompt as system prompt' };
      }
      return {
        output: `System prompt set from: ${arg}`,
        update: { systemPrompt: `<use-prompt:${arg}>` },
      };

    case 'system':
      if (!arg) {
        return { output: 'Usage: /system <text> — or /system clear to remove' };
      }
      if (arg === 'clear') {
        return { output: 'System prompt cleared', update: { systemPrompt: null } };
      }
      return {
        output: `System prompt set: ${arg.slice(0, 80)}${arg.length > 80 ? '...' : ''}`,
        update: { systemPrompt: arg },
      };

    case 'temp': {
      const val = parseFloat(arg);
      if (isNaN(val) || val < 0 || val > 1) {
        return { output: 'Usage: /temp <0-1>' };
      }
      return { output: `Temperature: ${val}`, update: { temperature: val } };
    }

    case 'maxTokens': {
      const val = parseInt(arg, 10);
      if (isNaN(val) || val < 1) {
        return { output: 'Usage: /maxTokens <n> (n >= 1)' };
      }
      return { output: `Max tokens: ${val}`, update: { maxTokens: val } };
    }

    case 'stream':
      if (arg === 'on') {
        return { output: 'Streaming: ON', update: { streamingEnabled: true } };
      }
      if (arg === 'off') {
        return { output: 'Streaming: OFF', update: { streamingEnabled: false } };
      }
      return { output: 'Usage: /stream on|off' };

    case 'quit':
    case 'exit':
      process.exit(0);

    default:
      return { output: `Unknown command: /${command}\nType /help for available commands` };
  }
}
