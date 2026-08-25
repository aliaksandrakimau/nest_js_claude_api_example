import { useState, useEffect, useCallback } from 'react';
import { Box, Text } from 'ink';
import { initialState } from './store.js';
import type { Message, StreamEvent } from './store.js';
import { fetchModels, createSession, chatStream, sendMessage } from './api.js';
import { handleCommand } from './commands.js';
import { StatusBar } from './components/StatusBar.js';
import { MessageLog } from './components/MessageLog.js';
import { StreamingText } from './components/StreamingText.js';
import { Composer } from './components/Composer.js';
import { ModelPicker } from './components/ModelPicker.js';

interface AppProps {
  baseUrl: string;
}

export function App({ baseUrl }: AppProps) {
  const [state, setState] = useState({ ...initialState, baseUrl });
  const [output, setOutput] = useState<string[]>([]);
  const [showPicker, setShowPicker] = useState(false);

  useEffect(() => {
    fetchModels(baseUrl)
      .then((models) => {
        setState((s) => ({ ...s, models, modelsLoaded: true }));
        setOutput((o) => [...o, `Loaded ${models.length} models. Type /help for commands.`]);
      })
      .catch((e) => {
        setOutput((o) => [...o, `Warning: could not load models: ${e.message}`]);
        setState((s) => ({ ...s, modelsLoaded: true }));
      });
  }, [baseUrl]);

  const handleUserInput = useCallback(async (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) return;

    if (trimmed.startsWith('/')) {
      const result = await handleCommand(trimmed, state);
      setOutput((o) => [...o, result.output]);
      if (result.update) setState((s) => ({ ...s, ...result.update }));
      if (result.showModelPicker) setShowPicker(true);
      return;
    }

    let sessionId = state.sessionId;
    if (!sessionId) {
      try {
        sessionId = await createSession(state.baseUrl);
        setState((s) => ({ ...s, sessionId }));
        setOutput((o) => [...o, `New session: ${sessionId}`]);
      } catch (e) {
        setOutput((o) => [...o, `Error creating session: ${e instanceof Error ? e.message : e}`]);
        return;
      }
    }

    const userMsg: Message = { role: 'user', content: trimmed };
    setState((s) => ({ ...s, messages: [...s.messages, userMsg], isStreaming: true }));

    try {
      if (state.streamingEnabled) {
        let fullText = '';
        for await (const event of chatStream({
          baseUrl: state.baseUrl,
          message: trimmed,
          model: state.model,
          sessionId,
          temperature: state.temperature,
          maxTokens: state.maxTokens,
          system: state.systemPrompt,
        })) {
          if (event.type === 'text_delta' && event.text) {
            fullText += event.text;
            setState((s) => ({ ...s, streamingText: fullText }));
          }
        }
        const assistantMsg: Message = { role: 'assistant', content: fullText, model: state.model };
        setState((s) => ({
          ...s,
          messages: [...s.messages, assistantMsg],
          streamingText: '',
          isStreaming: false,
        }));
      } else {
        const result = await sendMessage({
          baseUrl: state.baseUrl,
          message: trimmed,
          model: state.model,
          sessionId,
          temperature: state.temperature,
          maxTokens: state.maxTokens,
          system: state.systemPrompt,
        });
        const assistantMsg: Message = { role: 'assistant', content: result.text, model: result.model };
        setState((s) => ({
          ...s,
          messages: [...s.messages, assistantMsg],
          isStreaming: false,
        }));
      }
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      setOutput((o) => [...o, `Error: ${errorMsg}`]);
      setState((s) => ({ ...s, isStreaming: false, streamingText: '' }));
    }
  }, [state]);

  if (showPicker) {
    return (
      <ModelPicker
        models={state.models}
        currentModel={state.model}
        onSelect={(id) => {
          setState((s) => ({ ...s, model: id }));
          setOutput((o) => [...o, `Model: ${id}`]);
          setShowPicker(false);
        }}
        onClose={() => setShowPicker(false)}
      />
    );
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="column">
        {output.map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
        <MessageLog messages={state.messages} />
        {state.isStreaming && (
          <StreamingText text={state.streamingText} isDone={!state.isStreaming} />
        )}
      </Box>
      <Composer
        onSubmit={handleUserInput}
        isDisabled={state.isStreaming}
        model={state.model}
      />
      <StatusBar
        model={state.model}
        sessionId={state.sessionId}
        temperature={state.temperature}
        streamingEnabled={state.streamingEnabled}
        isStreaming={state.isStreaming}
      />
    </Box>
  );
}
