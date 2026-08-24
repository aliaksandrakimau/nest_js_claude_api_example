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
