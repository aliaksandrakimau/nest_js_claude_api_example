import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { ToolHandler, ToolDefinition } from './tool.interface';
import { toSdkTool } from './tool.interface';

/**
 * Central registry for tool handlers. Collects all ToolHandler implementations
 * provided via DI and exposes them to the ClaudeService for tool-call
 * orchestration.
 */
@Injectable()
export class ToolRegistryService {
  private readonly log = new Logger(ToolRegistryService.name);
  private readonly items: ToolHandler[] = [];
  private readonly byName = new Map<string, ToolHandler>();

  constructor(handlers: ToolHandler[]) {
    this.items = [...handlers];
    for (const current of this.items) {
      const def = current.definition();
      this.byName.set(def.name, current);
      this.log.log(['Registered tool:', def.name].join(' '));
    }
  }

  /** Returns all registered tools in Anthropic SDK format. */
  getToolDefinitions(): Tool[] {
    return this.items.map((h) => toSdkTool(h.definition()));
  }

  /** Returns tool definitions as plain objects (for metadata / logging). */
  getToolMeta(): ToolDefinition[] {
    return this.items.map((h) => h.definition());
  }

  /**
   * Dispatches a tool call to the matching handler.
   * Throws BadRequestException if no handler matches.
   */
  async dispatch(
    requestedId: string,
    input: Record<string, unknown>,
  ): Promise<string> {
    const handler = this.byName.get(requestedId);
    if (handler === undefined) {
      throw new BadRequestException('Unknown tool requested');
    }
    this.log.debug(['Invoking tool:', requestedId].join(' '));
    return handler.run(input);
  }

  /** Whether any tools are registered. */
  hasTools(): boolean {
    return this.items.length > 0;
  }
}
