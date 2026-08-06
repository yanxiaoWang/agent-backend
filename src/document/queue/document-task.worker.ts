import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectEntityManager } from '@nestjs/typeorm';
import Redis from 'ioredis';
import { EntityManager } from 'typeorm';
import { RustfsService } from '../../storage/rustfs.service';
import {
  DocumentTaskEntity,
  DocumentTaskStatus,
} from '../entities/document-task.entity';
import { DocumentIndexingService } from '../indexing/document-indexing.service';
import { DocumentService } from '../document.service';
import { FileParserService } from '../parser/file-parser.service';
import { DocumentTaskQueue } from './document-task.queue';
import type { UploadParseDto } from '../dto/upload-parse.dto';

/**
 * 文档任务消费者：解析 → 落库 → 分块向量/ES 索引。
 */
@Injectable()
export class DocumentTaskWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DocumentTaskWorker.name);
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private blocker: Redis | null = null;
  private readonly workerEnabled: boolean;

  constructor(
    private readonly queue: DocumentTaskQueue,
    private readonly documentService: DocumentService,
    private readonly fileParser: FileParserService,
    private readonly indexing: DocumentIndexingService,
    private readonly rustfs: RustfsService,
    @InjectEntityManager()
    private readonly em: EntityManager,
    config: ConfigService,
  ) {
    this.workerEnabled =
      config.get<string>('DOCUMENT_TASK_WORKER_ENABLED', 'true').toLowerCase() !==
      'false';
  }

  onModuleInit() {
    if (!this.workerEnabled) {
      this.logger.warn('文档任务 Worker 已禁用（DOCUMENT_TASK_WORKER_ENABLED=false）');
      return;
    }
    this.running = true;
    this.blocker = this.queue.createBlocker();
    this.loopPromise = this.pollLoop();
    this.logger.log('文档任务 Worker 已启动');
  }

  async onModuleDestroy() {
    this.running = false;
    if (this.blocker) {
      try {
        this.blocker.disconnect();
      } catch {
        // ignore
      }
      this.blocker = null;
    }
    if (this.loopPromise) {
      await this.loopPromise.catch(() => undefined);
    }
  }

  private async pollLoop(): Promise<void> {
    while (this.running && this.blocker) {
      try {
        const job = await this.queue.dequeue(this.blocker, 5);
        if (!job) continue;
        await this.processTask(job.taskId);
      } catch (err) {
        if (!this.running) break;
        this.logger.error(
          `Worker 轮询异常: ${err instanceof Error ? err.message : err}`,
        );
        await sleep(1000);
      }
    }
  }

  private async processTask(taskId: string): Promise<void> {
    const task = await this.em.findOne(DocumentTaskEntity, {
      where: { id: taskId },
    });
    if (!task) {
      this.logger.warn(`任务不存在，跳过: taskId=${taskId}`);
      return;
    }
    if (
      task.status === DocumentTaskStatus.Completed ||
      task.status === DocumentTaskStatus.Failed
    ) {
      this.logger.warn(`任务已结束，跳过: taskId=${taskId}, status=${task.status}`);
      return;
    }

    try {
      await this.updateTask(task, {
        status: DocumentTaskStatus.Parsing,
        progress: 10,
        step: '下载原文件',
      });

      const buffer = await this.loadFileBuffer(task);

      await this.updateTask(task, {
        progress: 30,
        step: '解析为 Markdown',
      });

      const content = await this.fileParser.parse({
        originalname: task.fileName,
        buffer,
        size: task.fileSize,
      });

      await this.updateTask(task, {
        progress: 55,
        step: '写入文档库',
      });

      const meta = (task.meta ?? {}) as UploadParseDto;
      const created = await this.documentService.createFromParsedUpload({
        fileName: task.fileName,
        fileExt: task.fileExt,
        fileSize: task.fileSize,
        fileUrl: task.fileUrl,
        content,
        meta,
      });

      await this.updateTask(task, {
        status: DocumentTaskStatus.Indexing,
        progress: 70,
        step: '分块与向量索引',
        documentId: created.documentId,
      });

      await this.indexing.indexDocument({
        documentId: created.documentId,
        title: created.title,
        content,
      });

      await this.updateTask(task, {
        status: DocumentTaskStatus.Completed,
        progress: 100,
        step: '完成',
        documentId: created.documentId,
        errorMessage: null,
      });

      this.logger.log(
        `任务完成: taskId=${taskId}, documentId=${created.documentId}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`任务失败: taskId=${taskId}, error=${message}`);
      await this.updateTask(task, {
        status: DocumentTaskStatus.Failed,
        progress: task.progress,
        step: '失败',
        errorMessage: message.slice(0, 2000),
      });
    }
  }

  private async loadFileBuffer(task: DocumentTaskEntity): Promise<Buffer> {
    if (task.fileKey && this.rustfs.isEnabled()) {
      return this.rustfs.downloadByKey(task.fileKey);
    }
    const stashed = await this.queue.takeStashedFile(task.id);
    if (stashed?.length) return stashed;
    throw new Error('无法获取原文件：RustFS key 与 Redis 暂存均不可用');
  }

  private async updateTask(
    task: DocumentTaskEntity,
    patch: Partial<DocumentTaskEntity>,
  ): Promise<void> {
    Object.assign(task, patch);
    await this.em.save(task);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
