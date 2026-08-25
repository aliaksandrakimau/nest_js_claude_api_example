import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

const DEFAULT_MODEL = 'claude-haiku-4-5';
const HEAVY_MODEL = 'claude-sonnet-4-5';
// Requests longer than this are considered heavy regardless of content.
const LONG_INPUT_THRESHOLD = 2000;
// Words that usually signal work worth a stronger model.
const COMPLEXITY_HINTS =
  /\b(refactor\w*|architect\w*|analyz\w*|debug|optimi[sz]e|migrat\w*|design|review|step[- ]by[- ]step|algorithm)\b/i;

/**
 * Cost-aware model selection. An explicitly requested model always wins;
 * otherwise simple inputs go to the fast default model and heavy-looking
 * ones (long text or complexity keywords) are escalated to a stronger,
 * pricier model. Heuristics on purpose — swap for a classifier or token
 * counting without touching callers if routing quality ever matters.
 */
@Injectable()
export class ModelRouterService {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext('ModelRouterService');
  }

  selectModel(explicitModel: string | undefined, inputText: string): string {
    if (explicitModel) {
      return explicitModel;
    }
    const isHeavy =
      inputText.length > LONG_INPUT_THRESHOLD ||
      COMPLEXITY_HINTS.test(inputText);
    const chosen = isHeavy ? HEAVY_MODEL : DEFAULT_MODEL;
    this.logger.debug(
      {
        chosen,
        reason: explicitModel
          ? 'explicit'
          : isHeavy
            ? 'heuristic: complex input'
            : 'heuristic: default',
      },
      'model routed',
    );
    return chosen;
  }
}
