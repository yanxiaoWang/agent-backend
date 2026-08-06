import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { OpenAIEmbeddings } from '@langchain/openai';
import { EntityManager } from 'typeorm';
import { nextSnowflakeId } from '../../common/snowflake-id';
import { DocumentChunkEntity } from '../entities/document-chunk.entity';
import { chunkMarkdown } from './chunker.util';
import { ElasticsearchService } from './elasticsearch.service';

export interface IndexDocumentInput {
  documentId: string;
  title: string;
  content: string;
}

/**
 * P2：分块 → PGVector embedding → Elasticsearch 关键词索引
 */
@Injectable()
export class DocumentIndexingService {
  private readonly logger = new Logger(DocumentIndexingService.name);
  private embeddings: OpenAIEmbeddings | null = null;

  constructor(
    @InjectEntityManager()
    private readonly em: EntityManager,
    private readonly elasticsearch: ElasticsearchService,
  ) {}

  /**
   * 对文档全文建索引：先清旧 chunk，再分块写 PG + 向量，再同步 ES。
   */
  async indexDocument(input: IndexDocumentInput): Promise<{ chunkCount: number }> {
    const chunks = await chunkMarkdown(input.content);
    if (!chunks.length) {
      this.logger.warn(`文档无有效分块: documentId=${input.documentId}`);
      return { chunkCount: 0 };
    }

    await this.clearDocumentChunks(input.documentId);

    const rows: DocumentChunkEntity[] = chunks.map((content, chunkIndex) =>
      this.em.create(DocumentChunkEntity, {
        id: nextSnowflakeId(),
        documentId: input.documentId,
        chunkIndex,
        content,
        contentLength: content.length,
        embedding: null,
      }),
    );

    await this.em.save(rows);

    try {
      await this.embedChunks(rows);
    } catch (err) {
      this.logger.error(
        `分块 embedding 失败（chunk 已落库）: documentId=${input.documentId}, err=${err instanceof Error ? err.message : err}`,
      );
      throw err;
    }

    try {
      await this.elasticsearch.indexChunks(
        rows.map((row) => ({
          chunkId: row.id,
          documentId: row.documentId,
          chunkIndex: row.chunkIndex,
          title: input.title,
          content: row.content,
          contentLength: row.contentLength,
        })),
      );
    } catch (err) {
      // ES 失败不阻断主流程
      this.logger.warn(
        `Elasticsearch 同步失败（已忽略）: ${err instanceof Error ? err.message : err}`,
      );
    }

    this.logger.log(
      `文档索引完成: documentId=${input.documentId}, chunks=${rows.length}`,
    );
    return { chunkCount: rows.length };
  }

  /** 语义检索：pgvector 余弦距离 */
  async searchSimilarChunks(
    query: string,
    limit = 8,
  ): Promise<
    Array<{
      id: string;
      documentId: string;
      chunkIndex: number;
      content: string;
      similarity: number;
    }>
  > {
    const vector = await this.getEmbeddings().embedQuery(query.trim());
    const rows = await this.em.query(
      `SELECT id, document_id AS "documentId", chunk_index AS "chunkIndex",
              content, 1 - (embedding <=> $1::vector) AS similarity
       FROM kh_document_chunk
       WHERE embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      [JSON.stringify(vector), limit],
    );

    return rows.map((row: Record<string, unknown>) => ({
      id: String(row.id),
      documentId: String(row.documentId),
      chunkIndex: Number(row.chunkIndex),
      content: String(row.content),
      similarity: Number(row.similarity),
    }));
  }

  private async clearDocumentChunks(documentId: string): Promise<void> {
    await this.em.delete(DocumentChunkEntity, { documentId });
    await this.elasticsearch.deleteByDocumentId(documentId).catch((err) => {
      this.logger.warn(
        `清理 ES 旧索引失败: ${err instanceof Error ? err.message : err}`,
      );
    });
  }

  private async embedChunks(rows: DocumentChunkEntity[]): Promise<void> {
    const batchSize = 16;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const vectors = await this.getEmbeddings().embedDocuments(
        batch.map((r) => r.content),
      );
      for (let j = 0; j < batch.length; j++) {
        await this.em.query(
          `UPDATE kh_document_chunk SET embedding = $1::vector WHERE id = $2`,
          [JSON.stringify(vectors[j]), batch[j].id],
        );
        batch[j].embedding = vectors[j];
      }
    }
  }

  private getEmbeddings(): OpenAIEmbeddings {
    if (!this.embeddings) {
      if (!process.env.OPENAI_API_KEY) {
        throw new BadRequestException(
          '文档索引需要配置 OPENAI_API_KEY 以生成 embedding',
        );
      }
      this.embeddings = new OpenAIEmbeddings({
        model: process.env.EMBEDDING_MODEL || 'text-embedding-v3',
        apiKey: process.env.OPENAI_API_KEY,
        configuration: {
          baseURL: process.env.OPENAI_BASE_URL,
        },
      });
    }
    return this.embeddings;
  }
}
