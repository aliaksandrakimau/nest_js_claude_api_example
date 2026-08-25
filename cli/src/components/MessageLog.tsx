import { Static, Box, Text } from 'ink';
import type { Message } from '../store.js';

interface MessageLogProps {
  messages: Message[];
}

export function MessageLog({ messages }: MessageLogProps) {
  return (
    <Box flexDirection="column">
      <Static items={messages}>
        {(msg) => (
          <Box key={`${msg.role}-${msg.content.length}-${msg.model ?? ''}`} flexDirection="column" marginBottom={1}>
            <Text bold color={msg.role === 'user' ? 'cyan' : 'green'}>
              [{msg.role}]
              {msg.model ? <Text dimColor> ({msg.model})</Text> : null}
            </Text>
            <Text>{msg.content}</Text>
          </Box>
        )}
      </Static>
    </Box>
  );
}
