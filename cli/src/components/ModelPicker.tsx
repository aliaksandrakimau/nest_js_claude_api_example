import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Model } from '../store.js';

interface ModelPickerProps {
  models: Model[];
  currentModel: string;
  onSelect: (modelId: string) => void;
  onClose: () => void;
}

export function ModelPicker({ models, currentModel, onSelect, onClose }: ModelPickerProps) {
  const [filter, setFilter] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);

  const filtered = models.filter(
    (m) =>
      m.id.toLowerCase().includes(filter.toLowerCase()) ||
      m.displayName.toLowerCase().includes(filter.toLowerCase()),
  );

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }

    if (key.return) {
      const selected = filtered[selectedIdx];
      if (selected) onSelect(selected.id);
      return;
    }

    if (key.upArrow) {
      setSelectedIdx((i) => (i - 1 + filtered.length) % filtered.length);
      return;
    }

    if (key.downArrow) {
      setSelectedIdx((i) => (i + 1) % filtered.length);
      return;
    }

    if (key.delete || key.backspace) {
      setFilter((f) => f.slice(0, -1));
      setSelectedIdx(0);
      return;
    }

    if (input && !key.ctrl && !key.escape) {
      setFilter((f) => f + input);
      setSelectedIdx(0);
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>Choose model (Esc to cancel, Enter to select):</Text>
      <Box marginTop={1}>
        <Text dimColor>Filter: </Text>
        <Text>{filter || '...'}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {filtered.slice(0, 30).map((m, i) => (
          <Box key={m.id}>
            <Text
              color={i === selectedIdx ? 'blue' : undefined}
              bold={i === selectedIdx}
            >
              {i === selectedIdx ? '> ' : '  '}
              {m.id}
              {m.id === currentModel ? <Text color="yellow"> (current)</Text> : null}
            </Text>
          </Box>
        ))}
        {filtered.length > 30 && (
          <Text dimColor>  ... and {filtered.length - 30} more</Text>
        )}
      </Box>
    </Box>
  );
}
