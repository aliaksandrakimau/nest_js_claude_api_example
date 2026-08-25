import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  // Route all Nest framework logging through pino so framework and
  // application logs share one structured format.
  app.useLogger(app.get(Logger));
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
