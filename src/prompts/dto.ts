import { IsString, Matches } from 'class-validator';

export class PromptUpsertDto {
  @IsString()
  @Matches(/\S/)
  text!: string;
}
