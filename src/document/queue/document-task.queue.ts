import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../memory/redis-message.store';

export interface DocumentTaskJob {
  taskId: string;
}

/**
 * Redis List 异步任务队列（LPUSH / BRPOP）。
 * 与会话短期记忆共用 Redis，独立 key。
 */
@Injectable()
export class DocumentTaskQueue {
  private readonly logger = new Logger(DocumentTaskQueue.name);
  private readonly queueKey: string;
  private readonly fileTtlSeconds: number;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    config: ConfigService,
  ) {
    this.queueKey = config.get<string>(
      'DOCUMENT_TASK_QUEUE_KEY',
      'kb:document_task:queue',
    );
    this.fileTtlSeconds = Number(
      config.get('DOCUMENT_TASK_FILE_TTL_SECONDS') ?? 3600,
    );
  }

  /** 入队任务 */
  async enqueue(job: DocumentTaskJob): Promise<void> {
    await this.redis.lpush(this.queueKey, JSON.stringify(job));
    this.logger.log(`任务入队: taskId=${job.taskId}`);
  }

  /**
   * 阻塞出队；timeoutSeconds 内无任务返回 null。
   * 使用 duplicate 连接，避免阻塞主 Redis client。
   */
  async dequeue(
    blocker: Redis,
    timeoutSeconds = 5,
  ): Promise<DocumentTaskJob | null> {
    const result = await blocker.brpop(this.queueKey, timeoutSeconds);
    if (!result) return null;
    const raw = result[1];
    try {
      return JSON.parse(raw) as DocumentTaskJob;
    } catch {
      this.logger.error(`非法任务载荷，已丢弃: ${raw}`);
      return null;
    }
  }

  createBlocker(): Redis {
    return this.redis.duplicate();
  }

  /** RustFS 不可用时，暂存原文件字节供 worker 消费 */
  async stashFile(taskId: string, buffer: Buffer): Promise<void> {
    const key = this.fileKey(taskId);
    await this.redis.set(key, buffer.toString('base64'), 'EX', this.fileTtlSeconds);
  }

  async takeStashedFile(taskId: string): Promise<Buffer | null> {
    const key = this.fileKey(taskId);
    const raw = await this.redis.get(key);
    if (!raw) return null;
    await this.redis.del(key);
    return Buffer.from(raw, 'base64');
  }

  private fileKey(taskId: string): string {
    return `kb:document_task:file:${taskId}`;
  }
}
