import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EntityManager } from 'typeorm';
import { nextSnowflakeId } from '../common/snowflake-id';
import { CreateDocumentDto } from './dto/create-document.dto';
import { UploadParseDto } from './dto/upload-parse.dto';
import {
  DocumentEntity,
  DocumentStatus,
} from './entities/document.entity';
import {
  DocumentTaskEntity,
  DocumentTaskStatus,
} from './entities/document-task.entity';
import {
  DocumentContent,
  DocumentContentDocument,
} from './schemas/document-content.schema';
import { RustfsService } from '../storage/rustfs.service';
import { FileParserService } from './parser/file-parser.service';
import {
  decodeUploadFilename,
  getExtension,
  titleFromFilename,
} from './parser/utils/markdown.util';
import { DocumentTaskQueue } from './queue/document-task.queue';
import { DocumentIndexingService } from './indexing/document-indexing.service';

export interface CreateFromParsedUploadInput {
  fileName: string;
  fileExt: string;
  fileSize: number;
  fileUrl?: string | null;
  content: string;
  meta?: UploadParseDto;
}

/**
 * 文档服务
 * - 元数据：PostgreSQL（kh_document）
 * - 正文：MongoDB（document_content）
 * - 异步任务：kh_document_task + Redis 队列
 * - 检索：kh_document_chunk（pgvector）+ Elasticsearch
 */
@Injectable()
export class DocumentService {
  private readonly logger = new Logger(DocumentService.name);

  constructor(
    @InjectEntityManager()
    private readonly em: EntityManager,
    @InjectModel(DocumentContent.name)
    private readonly contentModel: Model<DocumentContentDocument>,
    private readonly fileParserService: FileParserService,
    private readonly rustfs: RustfsService,
    private readonly taskQueue: DocumentTaskQueue,
    private readonly indexing: DocumentIndexingService,
  ) {}

  /**
   * 创建文档
   * 流程：生成雪花 ID → 写 Mongo 正文（拿 ObjectId）→ 写 Postgres 元数据
   * 若 Postgres 写入失败，回滚删除已写入的 Mongo 正文，避免脏数据
   */
  async create(dto: CreateDocumentDto) {
    const id = nextSnowflakeId();
    const wordCount = this.countWords(dto.content);
    const status = dto.status ?? DocumentStatus.Draft;
    const contentSummary = dto.summary ?? this.buildContentSummary(dto.content);

    const contentDoc = await this.contentModel.create({
      documentId: id,
      content: dto.content,
      contentLength: dto.content.length,
      contentSummary,
      version: 1,
      deleted: false,
    });

    const contentId = String(contentDoc._id);
    try {
      const doc = this.em.create(DocumentEntity, {
        id,
        title: dto.title,
        contentId,
        summary: dto.summary,
        categoryId: dto.categoryId,
        teamId: dto.teamId,
        authorId: dto.authorId,
        coverImage: dto.coverImage,
        fileUrl: dto.fileUrl,
        fileSize: dto.fileSize ?? 0,
        fileExt: dto.fileExt,
        tags: dto.tags,
        status,
        remark: dto.remark,
        isPublic: dto.isPublic ?? false,
        wordCount,
        publishTime: status === DocumentStatus.Published ? new Date() : null,
        createBy: dto.createBy,
        updateBy: dto.createBy,
        deleted: false,
      });
      const saved = await this.em.save(doc);
      return { ...saved, content: dto.content };
    } catch (error) {
      await this.contentModel.deleteOne({ _id: contentId });
      throw error;
    }
  }

  /**
   * P1：上传入队（立即返回 taskId）。
   * 1) 校验格式 2) 原文件进 RustFS（或 Redis 暂存）3) 写 document_task 4) Redis 入队
   */
  async enqueueUpload(file: Express.Multer.File, meta: UploadParseDto = {}) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('文件不能为空');
    }

    const originalFilename = decodeUploadFilename(file.originalname);
    const extension = getExtension(originalFilename);

    if (!this.fileParserService.isSupported(extension)) {
      throw new BadRequestException(
        `不支持的文件格式: ${extension}，支持的格式: ${this.fileParserService.supportedList()}`,
      );
    }

    const taskId = nextSnowflakeId();
    let fileUrl: string | null = null;
    let fileKey: string | null = null;

    if (this.rustfs.isEnabled()) {
      try {
        const uploaded = await this.rustfs.upload(file.buffer, {
          fileName: originalFilename,
          contentType: file.mimetype || 'application/octet-stream',
          prefix: 'documents',
        });
        fileUrl = uploaded.url;
        fileKey = uploaded.key;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`原文件上传 RustFS 失败：${message}`);
        throw new BadRequestException(`原文件上传失败: ${message}`);
      }
    } else {
      this.logger.warn('RustFS 未启用，原文件暂存 Redis 供 Worker 消费');
      await this.taskQueue.stashFile(taskId, file.buffer);
    }

    const task = this.em.create(DocumentTaskEntity, {
      id: taskId,
      status: DocumentTaskStatus.Queued,
      progress: 0,
      step: '排队中',
      fileName: originalFilename,
      fileExt: extension,
      fileSize: file.size,
      contentType: file.mimetype || 'application/octet-stream',
      fileUrl,
      fileKey,
      meta: {
        categoryId: meta.categoryId,
        teamId: meta.teamId,
        authorId: meta.authorId,
        tags: meta.tags,
        remark: meta.remark,
        createBy: meta.createBy,
        isPublic: meta.isPublic,
      },
      createBy: meta.createBy ?? null,
      errorMessage: null,
    });

    await this.em.save(task);
    await this.taskQueue.enqueue({ taskId });

    this.logger.log(
      `上传任务已入队: taskId=${taskId}, name=${originalFilename}, fileUrl=${fileUrl}`,
    );

    return {
      taskId,
      status: task.status,
      progress: task.progress,
      step: task.step,
      fileName: originalFilename,
      fileUrl,
    };
  }

  /** Worker：解析完成后创建草稿文档 */
  async createFromParsedUpload(input: CreateFromParsedUploadInput) {
    const title = titleFromFilename(input.fileName);
    const meta = input.meta ?? {};

    const created = await this.create({
      title,
      content: input.content,
      categoryId: meta.categoryId,
      teamId: meta.teamId,
      authorId: meta.authorId,
      tags: meta.tags,
      remark: meta.remark,
      createBy: meta.createBy,
      isPublic: meta.isPublic,
      status: DocumentStatus.Draft,
      fileUrl: input.fileUrl ?? undefined,
      fileSize: input.fileSize,
      fileExt: input.fileExt,
    });

    return {
      documentId: created.id,
      title,
      contentLength: input.content.length,
    };
  }

  /** 查询任务状态（前端轮询） */
  async getTask(taskId: string) {
    const task = await this.em.findOne(DocumentTaskEntity, {
      where: { id: taskId },
    });
    if (!task) {
      throw new NotFoundException(`任务不存在: ${taskId}`);
    }
    return {
      taskId: task.id,
      status: task.status,
      progress: task.progress,
      step: task.step,
      documentId: task.documentId,
      fileName: task.fileName,
      fileExt: task.fileExt,
      fileSize: task.fileSize,
      fileUrl: task.fileUrl,
      errorMessage: task.errorMessage,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  }

  /** 知识库语义检索（pgvector） */
  async search(query: string, limit = 8) {
    const q = query?.trim();
    if (!q) {
      throw new BadRequestException('查询内容不能为空');
    }
    return this.indexing.searchSimilarChunks(q, limit);
  }

  private buildContentSummary(content: string, maxLen = 200): string {
    const trimmed = content.trim().replace(/\s+/g, ' ');
    return trimmed.length <= maxLen
      ? trimmed
      : `${trimmed.slice(0, maxLen)}...`;
  }

  private countWords(content: string): number {
    const trimmed = content.trim();
    if (!trimmed) return 0;

    const cjk = (trimmed.match(/[\u4e00-\u9fff]/g) ?? []).length;
    const latin = trimmed
      .replace(/[\u4e00-\u9fff]/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean).length;

    return cjk + latin;
  }
}
