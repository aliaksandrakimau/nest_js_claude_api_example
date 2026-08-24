import { DynamicModule, Module, Type } from '@nestjs/common';
import { ToolRegistryService } from './tool-registry.service';
import type { ToolHandler } from './tool.interface';

/**
 * Dynamic module for tool registration. Use `ToolsModule.forRoot()` with an
 * array of ToolHandler provider classes to register tools at the module level.
 *
 * @example
 * ```ts
 * @Module({
 *   imports: [ToolsModule.forRoot([CalculatorTool])],
 * })
 * export class AppModule {}
 * ```
 */
@Module({})
export class ToolsModule {
  static forRoot(handlers: Type<ToolHandler>[] = []): DynamicModule {
    return {
      module: ToolsModule,
      providers: [
        ...handlers,
        {
          provide: ToolRegistryService,
          // Each injected token resolves to one registered ToolHandler.
          useFactory: (...resolved: ToolHandler[]) =>
            new ToolRegistryService(resolved),
          inject: [...handlers],
        },
      ],
      exports: [ToolRegistryService],
      global: true,
    };
  }
}
