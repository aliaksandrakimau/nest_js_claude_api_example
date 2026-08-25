import { Box, Text } from 'ink';

interface StatusBarProps {
  model: string;
  sessionId: string | null;
  temperature: number;
  streamingEnabled: boolean;
  isStreaming: boolean;
}

export function StatusBar({
  model,
  sessionId,
  temperature,
  streamingEnabled,
  isStreaming,
}: StatusBarProps) {
  return (
    <Box>
      <Text color="yellow" bold>{model}</Text>
      <Text dimColor> | </Text>
      <Text color="blue">
        {sessionId ? `session: ${sessionId.slice(0, 8)}` : 'no session'}
      </Text>
      <Text dimColor> | </Text>
      <Text dimColor>temp: {temperature}</Text>
      <Text dimColor> | </Text>
      <Text color={streamingEnabled ? 'green' : 'gray'}>
        stream: {streamingEnabled ? 'on' : 'off'}
      </Text>
      {isStreaming && (
        <>
          <Text dimColor> | </Text>
          <Text color="cyan">generating...</Text>
        </>
      )}
    </Box>
  );
}
