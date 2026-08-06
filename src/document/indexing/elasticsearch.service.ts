import { Client } from '@elastic/elasticsearch';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface EsChunkDoc {
  chunkId: string;
  documentId: string;
  chunkIndex: number;
  title: string;
  content: string;
  contentLength: number;
}

/**
 * Elasticsearch 关键词倒排索引（可选）。
 * ELASTICSEARCH_ENABLED=false 或未配置节点时跳过，不影响主流程。
 */
@Injectable()
export class ElasticsearchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ElasticsearchService.name);
  private client: Client | null = null;
  private enabled = false;
  private indexName = 'document_chunks';

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    this.enabled =
      this.config.get<string>('ELASTICSEARCH_ENABLED', 'false').toLowerCase() ===
      'true';
    this.indexName = this.config.get<string>(
      'ELASTICSEARCH_INDEX',
      'document_chunks',
    );

    if (!this.enabled) {
      this.logger.warn(
        'Elasticsearch 未启用（ELASTICSEARCH_ENABLED!=true），跳过关键词索引',
      );
      return;
    }

    const node = this.config.get<string>(
      'ELASTICSEARCH_NODE',
      'http://localhost:9200',
    );
    this.client = new Client({ node });

    try {
      await this.ensureIndex();
      this.logger.log(`Elasticsearch ready: node=${node}, index=${this.indexName}`);
    } catch (err) {
      this.logger.warn(
        `Elasticsearch 初始化失败，后续索引将跳过: ${err instanceof Error ? err.message : err}`,
      );
      this.client = null;
      this.enabled = false;
    }
  }

  async onModuleDestroy() {
    if (this.client) {
      await this.client.close().catch(() => undefined);
    }
  }

  isEnabled(): boolean {
    return this.enabled && this.client != null;
  }

  /** 批量写入分块关键词索引；未启用时 no-op */
  async indexChunks(docs: EsChunkDoc[]): Promise<void> {
    if (!this.isEnabled() || !this.client || !docs.length) return;

    const operations = docs.flatMap((doc) => [
      { index: { _index: this.indexName, _id: doc.chunkId } },
      {
        chunkId: doc.chunkId,
        documentId: doc.documentId,
        chunkIndex: doc.chunkIndex,
        title: doc.title,
        content: doc.content,
        contentLength: doc.contentLength,
      },
    ]);

    const result = await this.client.bulk({ refresh: true, operations });
    if (result.errors) {
      const failed = result.items?.filter((item) => item.index?.error) ?? [];
      this.logger.warn(
        `Elasticsearch bulk 部分失败: ${failed.length}/${docs.length}`,
      );
    } else {
      this.logger.log(`Elasticsearch 索引完成: ${docs.length} chunks`);
    }
  }

  /** 删除某文档下全部分块索引 */
  async deleteByDocumentId(documentId: string): Promise<void> {
    if (!this.isEnabled() || !this.client) return;
    await this.client.deleteByQuery({
      index: this.indexName,
      query: { term: { documentId } },
      refresh: true,
    });
  }

  private async ensureIndex(): Promise<void> {
    if (!this.client) return;
    const exists = await this.client.indices.exists({ index: this.indexName });
    if (exists) return;

    await this.client.indices.create({
      index: this.indexName,
      mappings: {
        properties: {
          chunkId: { type: 'keyword' },
          documentId: { type: 'keyword' },
          chunkIndex: { type: 'integer' },
          title: { type: 'text' },
          content: { type: 'text' },
          contentLength: { type: 'integer' },
        },
      },
    });
    this.logger.log(`Elasticsearch index created: ${this.indexName}`);
  }
}
