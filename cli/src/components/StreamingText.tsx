import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';

interface StreamingTextProps {
  text: string;
  isDone: boolean;
}

export function StreamingText({ text, isDone }: StreamingTextProps) {
  if (!text && isDone) return null;

  return (
    <Box flexDirection="column">
      <Text bold color="green">[assistant]</Text>
      <Text>
        {text}
        {!isDone && <Text color="cyan"><Spinner type="dots" /></Text>}
      </Text>
    </Box>
  );
}
