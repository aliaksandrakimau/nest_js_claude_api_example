import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';

/**
 * Definition returned by a tool handler. Maps directly to the Anthropic SDK's
 * Tool type but uses a simpler interface so handlers don't depend on SDK types.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Interface for tool handlers registered via DI. Each handler defines its own
 * schema and invocation logic. Register handlers by providing them in the
 * ToolsModule.forRoot() call or via a feature module.
 *
 * @example
 * ```ts
 * @Injectable()
 * export class WeatherTool implements ToolHandler {
 *   definition() {
 *     return {
 *       name: 'weather',
 *       description: 'Look up current weather',
 *       inputSchema: {
 *         type: 'object',
 *         properties: { city: { type: 'string' } },
 *         required: ['city'],
 *       },
 *     };
 *   }
 *
 *   async run(input: { city: string }) {
 *     return fetchWeather(input.city);
 *   }
 * }
 * ```
 */
export interface ToolHandler {
  definition(): ToolDefinition;
  // Declared as a function-valued property (not a method) so handlers can be
  // passed around and mocked without losing `this`.
  run: (input: Record<string, unknown>) => Promise<string>;
}

/** Converts a ToolDefinition to the Anthropic SDK Tool format. */
export function toSdkTool(def: ToolDefinition): Tool {
  return {
    name: def.name,
    description: def.description,
    // ToolDefinition keeps the schema loosely typed so handlers can build it
    // inline; the SDK's InputSchema is structurally compatible.
    input_schema: def.inputSchema as Tool['input_schema'],
  };
}
