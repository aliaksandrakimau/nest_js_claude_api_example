import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { ClaudeService } from './claude/claude.service';

describe('AppController', () => {
  let controller: AppController;
  let claudeService: {
    sendMessage: jest.Mock;
    createConversation: jest.Mock;
    listModels: jest.Mock;
  };

  beforeEach(async () => {
    claudeService = {
      sendMessage: jest.fn().mockResolvedValue({}),
      createConversation: jest.fn().mockResolvedValue({}),
      listModels: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [{ provide: ClaudeService, useValue: claudeService }],
    }).compile();

    controller = module.get<AppController>(AppController);
  });

  it('sendMessage delegates to ClaudeService', async () => {
    const request = { message: 'Hi' };

    await controller.sendMessage(request);

    expect(claudeService.sendMessage).toHaveBeenCalledWith(request);
  });

  it('createConversation delegates to ClaudeService', async () => {
    const request = { messages: [{ role: 'user', content: 'Hi' }] };

    await controller.createConversation(request);

    expect(claudeService.createConversation).toHaveBeenCalledWith(request);
  });

  it('listModels delegates to ClaudeService', async () => {
    await controller.listModels();

    expect(claudeService.listModels).toHaveBeenCalled();
  });
});
