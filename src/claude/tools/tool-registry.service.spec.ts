import { BadRequestException } from '@nestjs/common';
import { ToolRegistryService } from './tool-registry.service';
import type { ToolHandler } from './tool.interface';
import { CalculatorTool } from './example-tool';

function stubTool(name: string): ToolHandler {
  return {
    definition: () => ({
      name,
      description: ['Stub tool:', name].join(' '),
      inputSchema: { type: 'object', properties: {} },
    }),
    run: jest.fn().mockResolvedValue(['result from', name].join(' ')),
  };
}

describe('ToolRegistryService', () => {
  describe('constructor', () => {
    it('registers all provided handlers', () => {
      const tool = stubTool('alpha');
      const registry = new ToolRegistryService([tool]);

      expect(registry.hasTools()).toBe(true);
      expect(registry.getToolMeta()).toHaveLength(1);
      expect(registry.getToolMeta()[0].name).toBe('alpha');
    });

    it('handles empty handler list', () => {
      const registry = new ToolRegistryService([]);

      expect(registry.hasTools()).toBe(false);
      expect(registry.getToolDefinitions()).toEqual([]);
    });
  });

  describe('getToolDefinitions', () => {
    it('maps handlers to Anthropic SDK Tool format', () => {
      const tool = stubTool('search');
      const registry = new ToolRegistryService([tool]);

      const defs = registry.getToolDefinitions();
      expect(defs).toEqual([
        {
          name: 'search',
          description: 'Stub tool: search',
          input_schema: { type: 'object', properties: {} },
        },
      ]);
    });
  });

  describe('dispatch', () => {
    it('routes to the matching handler', async () => {
      const tool = stubTool('calculator');
      const registry = new ToolRegistryService([tool]);

      const result = await registry.dispatch('calculator', { x: 1 });

      expect(result).toBe('result from calculator');
      expect(tool.run as jest.Mock).toHaveBeenCalledWith({ x: 1 });
    });

    it('throws BadRequestException for unknown tools', async () => {
      const registry = new ToolRegistryService([]);

      await expect(registry.dispatch('nonexistent', {})).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('CalculatorTool', () => {
    it('evaluates simple addition', async () => {
      const tool = new CalculatorTool();
      const result = await tool.run({ expression: '2 + 3' });
      expect(JSON.parse(result)).toBe(5);
    });

    it('evaluates nested expressions', async () => {
      const tool = new CalculatorTool();
      const result = await tool.run({ expression: '(2 + 3) * 4' });
      expect(JSON.parse(result)).toBe(20);
    });

    it('handles division', async () => {
      const tool = new CalculatorTool();
      const result = await tool.run({ expression: '10 / 2' });
      expect(JSON.parse(result)).toBe(5);
    });

    it('handles negative numbers', async () => {
      const tool = new CalculatorTool();
      const result = await tool.run({ expression: '-5 + 3' });
      expect(JSON.parse(result)).toBe(-2);
    });

    it('returns error for invalid expressions', async () => {
      const tool = new CalculatorTool();
      const result = await tool.run({ expression: 'abc' });
      const parsed = JSON.parse(result) as { error?: string };
      expect(parsed).toHaveProperty('error');
    });

    it('returns correct definition', () => {
      const tool = new CalculatorTool();
      const def = tool.definition();
      expect(def.name).toBe('calculator');
      expect(def.inputSchema).toHaveProperty('properties.expression');
    });
  });
});
