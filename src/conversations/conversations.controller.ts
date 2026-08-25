import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import {
  ConversationStoreService,
  ConversationMessage,
} from './conversation-store.service';

@Controller('claude/sessions')
export class ConversationsController {
  constructor(private readonly store: ConversationStoreService) {}

  @Post()
  create(): { sessionId: string } {
    return { sessionId: this.store.createSession() };
  }

  @Get(':id')
  history(@Param('id') id: string): {
    sessionId: string;
    messages: ConversationMessage[];
  } {
    try {
      return { sessionId: id, messages: this.store.getHistory(id) };
    } catch {
      // Unknown sessions are a missing resource here, not a malformed request.
      throw new NotFoundException('Unknown or expired sessionId');
    }
  }
}
