import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

// Shared optional parameters accepted by every Claude endpoint.
export class ClaudeRequestOptionsDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  model?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxTokens?: number;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  system?: string;

  // The Anthropic API only accepts temperature values in the [0, 1] range.
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  temperature?: number;
}

export class SendMessageRequestDto extends ClaudeRequestOptionsDto {
  // IsNotEmpty alone would let whitespace-only strings through.
  @IsString()
  @Matches(/\S/)
  message!: string;
}

export class ConversationMessageDto {
  @IsIn(['user', 'assistant'])
  role!: 'user' | 'assistant';

  @IsString()
  @Matches(/\S/)
  content!: string;
}

export class ConversationRequestDto extends ClaudeRequestOptionsDto {
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => ConversationMessageDto)
  messages!: ConversationMessageDto[];
}

export class StreamRequestDto extends ClaudeRequestOptionsDto {
  // The stream endpoint accepts either a single message or a full history.
  // Each field is required only while the other one is absent; providing both
  // passes per-field validation and is rejected by the service with a clear
  // error, because class-validator has no built-in cross-field XOR rule.
  @ValidateIf((o: StreamRequestDto) => o.messages === undefined)
  @IsString()
  @Matches(/\S/)
  message?: string;

  @ValidateIf((o: StreamRequestDto) => o.message === undefined)
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => ConversationMessageDto)
  messages?: ConversationMessageDto[];
}

// Same shape as StreamRequestDto, but served by the tool-orchestrating /chat
// endpoint. Kept as a distinct class so the two endpoints can diverge later
// (e.g. per-request tool selection) without breaking the stream contract.
export class ChatRequestDto extends ClaudeRequestOptionsDto {
  @ValidateIf((o: ChatRequestDto) => o.messages === undefined)
  @IsString()
  @Matches(/\S/)
  message?: string;

  @ValidateIf((o: ChatRequestDto) => o.message === undefined)
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => ConversationMessageDto)
  messages?: ConversationMessageDto[];
}
