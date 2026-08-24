import { Injectable, Logger } from '@nestjs/common';
import type { ToolHandler } from './tool.interface';

/**
 * Example calculator tool for demonstration purposes. Evaluates simple math
 * expressions using a safe token-based parser (no eval / Function constructor).
 *
 * Supports: +, -, *, /, parentheses, decimal numbers.
 */
@Injectable()
export class CalculatorTool implements ToolHandler {
  private readonly log = new Logger(CalculatorTool.name);

  definition() {
    return {
      name: 'calculator',
      description: 'Evaluate a simple math expression (e.g. "2 + 3 * 4")',
      inputSchema: {
        type: 'object' as const,
        properties: {
          expression: {
            type: 'string',
            description: 'The math expression to evaluate',
          },
        },
        required: ['expression'],
      },
    };
  }

  run(input: Record<string, unknown>): Promise<string> {
    // Non-string inputs are serialized instead of stringified blindly, so an
    // object expression can never produce "[object Object]".
    const raw = input.expression;
    const expr = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
    this.log.debug(['Evaluating:', expr].join(' '));
    try {
      return Promise.resolve(JSON.stringify(this.safeEvaluate(expr)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Promise.resolve(JSON.stringify({ error: message }));
    }
  }

  /**
   * Safe math expression evaluator. Tokenizes the input and computes the
   * result using recursive descent parsing — no dynamic code execution.
   */
  private safeEvaluate(expression: string): number {
    const tokens = this.tokenize(expression);
    let pos = 0;

    const peek = () => tokens[pos];
    const consume = () => tokens[pos++];

    const parseExpr = (): number => {
      let left = parseTerm();
      while (peek() === '+' || peek() === '-') {
        const op = consume();
        const right = parseTerm();
        left = op === '+' ? left + right : left - right;
      }
      return left;
    };

    const parseTerm = (): number => {
      let left = parseFactor();
      while (peek() === '*' || peek() === '/') {
        const op = consume();
        const right = parseFactor();
        left = op === '*' ? left * right : left / right;
      }
      return left;
    };

    const parseFactor = (): number => {
      if (peek() === '(') {
        consume(); // (
        const val = parseExpr();
        consume(); // )
        return val;
      }
      if (peek() === '-') {
        consume();
        return -parseFactor();
      }
      const token = consume();
      const num = Number(token);
      if (Number.isNaN(num)) {
        throw new Error(['Unexpected token:', token].join(' '));
      }
      return num;
    };

    const result = parseExpr();
    if (pos < tokens.length) {
      throw new Error(['Unexpected token:', tokens[pos]].join(' '));
    }
    return result;
  }

  private tokenize(expression: string): string[] {
    const tokens: string[] = [];
    const cleaned = expression.replace(/\s+/g, '');
    let i = 0;
    while (i < cleaned.length) {
      const ch = cleaned[i];
      if ('+-*/()'.includes(ch)) {
        tokens.push(ch);
        i++;
      } else if ((ch >= '0' && ch <= '9') || ch === '.') {
        let num = '';
        while (
          i < cleaned.length &&
          ((cleaned[i] >= '0' && cleaned[i] <= '9') || cleaned[i] === '.')
        ) {
          num += cleaned[i++];
        }
        tokens.push(num);
      } else {
        throw new Error(['Invalid character:', ch].join(' '));
      }
    }
    return tokens;
  }
}
