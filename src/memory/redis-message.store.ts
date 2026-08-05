import {
  Inject,
  Injectable,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import {
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages,
  type BaseMessage,
} from '@langchain/core/messages';

export const REDIS_CLIENT = 'REDIS_CLIENT';

@Injectable()
export class RedisMessageStore implements OnModuleDestroy {
  private readonly logger = new Logger(RedisMessageStore.name);
  private readonly keyPrefix: string;
  private readonly ttlSeconds: number;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    config: ConfigService,
  ) {
    this.keyPrefix =
      config.get<string>('MEMORY_KEY_PREFIX') ?? 'agent:short_memory';
    this.ttlSeconds = Number(config.get('MEMORY_TTL_SECONDS') ?? 1800);
  }

  messagesKey(sessionId: string) {
    return `${this.keyPrefix}:${sessionId}:messages`;
  }

  async loadMessages(sessionId: string): Promise<BaseMessage[]> {
    const raw = await this.redis.get(this.messagesKey(sessionId));
    if (!raw) return [];
    return mapStoredMessagesToChatMessages(JSON.parse(raw));
  }

  async saveMessages(sessionId: string, messages: BaseMessage[]) {
    const payload = JSON.stringify(mapChatMessagesToStoredMessages(messages));
    await this.redis.set(
      this.messagesKey(sessionId),
      payload,
      'EX',
      this.ttlSeconds,
    );
  }

  async clear(sessionId: string) {
    await this.redis.del(this.messagesKey(sessionId));
  }

  async ttl(sessionId: string) {
    return this.redis.ttl(this.messagesKey(sessionId));
  }

  async onModuleDestroy() {
    try {
      await this.redis.quit();
    } catch (err) {
      this.logger.warn(`Redis quit failed: ${(err as Error).message}`);
    }
  }
}
