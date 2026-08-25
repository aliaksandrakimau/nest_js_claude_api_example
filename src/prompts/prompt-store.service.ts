import { BadRequestException, Injectable } from '@nestjs/common';

export interface StoredPrompt {
  name: string;
  /** Current version; starts at 1 and increments on every upsert. */
  version: number;
  text: string;
  updatedAt: string;
}

interface PromptRecord {
  version: number;
  text: string;
  updatedAt: string;
}

/**
 * Versioned system prompt store. Keeps prompts in memory — enough for a
 * single-instance example app; swap the Map for Redis/SQLite to share state
 * across replicas.
 */
@Injectable()
export class PromptStoreService {
  private readonly prompts = new Map<string, PromptRecord>();

  /** Creates or updates a prompt; every save bumps the version. */
  upsert(name: string, text: string): StoredPrompt {
    const existing = this.prompts.get(name);
    const record: PromptRecord = {
      version: (existing?.version ?? 0) + 1,
      text,
      updatedAt: new Date().toISOString(),
    };
    this.prompts.set(name, record);
    return this.toStored(name, record);
  }

  /** Returns the current prompt or throws 400 for an unknown name. */
  get(name: string): StoredPrompt {
    const record = this.prompts.get(name);
    if (!record) {
      throw new BadRequestException(`Unknown prompt: ${name}`);
    }
    return this.toStored(name, record);
  }

  list(): StoredPrompt[] {
    return Array.from(this.prompts.entries()).map(([name, record]) =>
      this.toStored(name, record),
    );
  }

  private toStored(name: string, record: PromptRecord): StoredPrompt {
    return {
      name,
      version: record.version,
      text: record.text,
      updatedAt: record.updatedAt,
    };
  }
}
