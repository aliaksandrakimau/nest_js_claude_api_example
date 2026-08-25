import { Global, Module } from '@nestjs/common';
import { ConversationsController } from './conversations.controller';
import { ConversationStoreService } from './conversation-store.service';

@Global()
@Module({
  controllers: [ConversationsController],
  providers: [ConversationStoreService],
  exports: [ConversationStoreService],
})
export class ConversationsModule {}
