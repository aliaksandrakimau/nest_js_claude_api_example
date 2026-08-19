import { Body, Controller, Get, Post } from '@nestjs/common';
import { ClaudeService } from './claude/claude.service';
import type {
  ClaudeModel,
  ClaudeResponse,
  ConversationRequest,
  SendMessageRequest,
} from './claude/interfaces';

@Controller()
export class AppController {
  constructor(private readonly claudeService: ClaudeService) {}

  @Post('claude/message')
  sendMessage(@Body() request: SendMessageRequest): Promise<ClaudeResponse> {
    return this.claudeService.sendMessage(request);
  }

  @Post('claude/conversation')
  createConversation(
    @Body() request: ConversationRequest,
  ): Promise<ClaudeResponse> {
    return this.claudeService.createConversation(request);
  }

  @Get('claude/models')
  listModels(): Promise<ClaudeModel[]> {
    return this.claudeService.listModels();
  }
}
