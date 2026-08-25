import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';

interface ComposerProps {
  onSubmit: (value: string) => void;
  isDisabled: boolean;
  model: string;
}

const COMMANDS = [
  '/help', '/models', '/model', '/sessions', '/new', '/use', '/history',
  '/prompts', '/prompt', '/system', '/temp', '/maxTokens', '/stream', '/quit',
];

export function Composer({ onSubmit, isDisabled, model }: ComposerProps) {
  const [value, setValue] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);

  useInput((input, key) => {
    if (isDisabled) return;

    if (key.tab && suggestions.length > 0) {
      const selected = suggestions[selectedIdx] ?? suggestions[0];
      setValue(selected + ' ');
      setSuggestions([]);
      return;
    }

    if (key.upArrow && suggestions.length > 0) {
      setSelectedIdx((i) => (i - 1 + suggestions.length) % suggestions.length);
      return;
    }

    if (key.downArrow && suggestions.length > 0) {
      setSelectedIdx((i) => (i + 1) % suggestions.length);
      return;
    }
  });

  const handleChange = (val: string) => {
    setValue(val);
    if (val.startsWith('/') && !val.includes(' ')) {
      const matches = COMMANDS.filter((c) => c.startsWith(val));
      setSuggestions(matches);
      setSelectedIdx(0);
    } else {
      setSuggestions([]);
    }
  };

  const handleSubmit = (val: string) => {
    setValue('');
    setSuggestions([]);
    onSubmit(val);
  };

  return (
    <Box flexDirection="column">
      {suggestions.length > 0 && (
        <Box marginBottom={1}>
          <Text dimColor>  {suggestions.join('  ')}</Text>
        </Box>
      )}
      <Box>
        <Text color="green" bold>&gt; </Text>
        <TextInput
          value={value}
          onChange={handleChange}
          onSubmit={handleSubmit}
          placeholder={`ask ${model} something...`}
          focus={!isDisabled}
          showCursor={!isDisabled}
        />
      </Box>
    </Box>
  );
}
