import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { PromptStoreService } from './prompt-store.service';
import type { StoredPrompt } from './prompt-store.service';
import { PromptUpsertDto } from './dto';

@Controller('claude/prompts')
export class PromptsController {
  constructor(private readonly promptStore: PromptStoreService) {}

  @Get()
  list(): StoredPrompt[] {
    return this.promptStore.list();
  }

  @Get(':name')
  get(@Param('name') name: string): StoredPrompt {
    return this.promptStore.get(name);
  }

  @Put(':name')
  upsert(
    @Param('name') name: string,
    @Body() body: PromptUpsertDto,
  ): StoredPrompt {
    return this.promptStore.upsert(name, body.text);
  }
}
