import { Body, Controller, Get, Post } from '@nestjs/common';
import { ClaudeService } from './claude/claude.service';
import { ConversationRequestDto, SendMessageRequestDto } from './claude/dto';
import type { ClaudeModel, ClaudeResponse } from './claude/interfaces';

@Controller()
export class AppController {
  constructor(private readonly claudeService: ClaudeService) {}

  @Post('claude/message')
  sendMessage(@Body() request: SendMessageRequestDto): Promise<ClaudeResponse> {
    return this.claudeService.sendMessage(request);
  }

  @Post('claude/conversation')
  createConversation(
    @Body() request: ConversationRequestDto,
  ): Promise<ClaudeResponse> {
    return this.claudeService.createConversation(request);
  }

  @Get('claude/models')
  listModels(): Promise<ClaudeModel[]> {
    return this.claudeService.listModels();
  }
}
