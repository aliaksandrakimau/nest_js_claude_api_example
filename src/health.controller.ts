import { Controller, Get } from '@nestjs/common';

// Liveness probe for container orchestrators and load balancers. Deliberately
// dependency-free: it reports that the process is up, not that the upstream
// Anthropic API is reachable.
@Controller('health')
export class HealthController {
  @Get()
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
