import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  // Route all Nest framework logging through pino so framework and
  // application logs share one structured format.
  app.useLogger(app.get(Logger));
  const config = app.get(ConfigService);
  app.enableCors();
  await app.listen(config.get<string>('PORT') ?? 3000);
}
void bootstrap();
