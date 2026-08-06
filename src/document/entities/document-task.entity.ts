import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { bigintTransformer } from '../../common/transformers/bigint.transformer';

/** 文档异步任务状态机 */
export enum DocumentTaskStatus {
  Queued = 'queued',
  Parsing = 'parsing',
  Indexing = 'indexing',
  Completed = 'completed',
  Failed = 'failed',
}

/** 文档上传解析任务（PostgreSQL kh_document_task） */
@Entity('kh_document_task')
export class DocumentTaskEntity {
  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  id: string;

  @Column({ type: 'varchar', length: 32, default: DocumentTaskStatus.Queued })
  status: DocumentTaskStatus;

  /** 0–100 */
  @Column({ type: 'smallint', default: 0 })
  progress: number;

  /** 当前步骤说明，供前端展示 */
  @Column({ type: 'varchar', length: 128, nullable: true })
  step?: string | null;

  @Column({
    name: 'document_id',
    type: 'bigint',
    nullable: true,
    transformer: bigintTransformer,
  })
  documentId?: string | null;

  @Column({ name: 'file_name', type: 'varchar' })
  fileName: string;

  @Column({ name: 'file_ext', type: 'varchar', length: 32 })
  fileExt: string;

  @Column({ name: 'file_size', type: 'int', default: 0 })
  fileSize: number;

  @Column({ name: 'content_type', type: 'varchar', nullable: true })
  contentType?: string | null;

  /** RustFS 可访问 URL */
  @Column({ name: 'file_url', type: 'varchar', nullable: true })
  fileUrl?: string | null;

  /** RustFS object key，供 worker 下载 */
  @Column({ name: 'file_key', type: 'varchar', nullable: true })
  fileKey?: string | null;

  /** 上传时的可选元数据（分类、标签等） */
  @Column({ type: 'jsonb', nullable: true })
  meta?: Record<string, unknown> | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage?: string | null;

  @Column({
    name: 'create_by',
    type: 'bigint',
    nullable: true,
    transformer: bigintTransformer,
  })
  createBy?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
