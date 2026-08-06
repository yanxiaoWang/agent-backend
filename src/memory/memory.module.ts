import { Global, Module, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import MemoryClient from 'mem0ai';
import { REDIS_CLIENT, RedisMessageStore } from './redis-message.store';
import { MEM0_CLIENT, Mem0MemoryStore } from './mem0-memory.store';

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const logger = new Logger('Redis');
        const redis = new Redis({
          host: config.get<string>('REDIS_HOST', 'localhost'),
          port: Number(config.get('REDIS_PORT') ?? 6379),
          db: Number(config.get('REDIS_DB') ?? 0),
          maxRetriesPerRequest: 3,
          lazyConnect: false,
        });

        redis.on('connect', () => logger.log('Redis connected'));
        redis.on('error', (err) =>
          logger.error(`Redis error: ${err.message}`),
        );

        return redis;
      },
    },
    {
      provide: MEM0_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const apiKey = config.get<string>('MEM0_API_KEY')?.trim();
        if (!apiKey) return null;
        const logger = new Logger('Mem0');
        logger.log('Mem0 MemoryClient ready');
        return new MemoryClient({ apiKey });
      },
    },
    RedisMessageStore,
    Mem0MemoryStore,
  ],
  exports: [REDIS_CLIENT, RedisMessageStore, Mem0MemoryStore],
})
export class MemoryModule {}
