import { MigrationInterface, QueryRunner } from 'typeorm';

export class DocumentTaskAndChunks1785903200000 implements MigrationInterface {
  name = 'DocumentTaskAndChunks1785903200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS vector`);

    await queryRunner.query(`
      ALTER TABLE "kh_document"
      ADD COLUMN IF NOT EXISTS "file_url" VARCHAR,
      ADD COLUMN IF NOT EXISTS "file_size" INT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "file_ext" VARCHAR
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "kh_document_task" (
        "id" BIGINT PRIMARY KEY,
        "status" VARCHAR(32) NOT NULL DEFAULT 'queued',
        "progress" SMALLINT NOT NULL DEFAULT 0,
        "step" VARCHAR(128),
        "document_id" BIGINT,
        "file_name" VARCHAR NOT NULL,
        "file_ext" VARCHAR(32) NOT NULL,
        "file_size" INT NOT NULL DEFAULT 0,
        "content_type" VARCHAR,
        "file_url" VARCHAR,
        "file_key" VARCHAR,
        "meta" JSONB,
        "error_message" TEXT,
        "create_by" BIGINT,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_document_task_status_created"
      ON "kh_document_task" ("status", "created_at")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "kh_document_chunk" (
        "id" BIGINT PRIMARY KEY,
        "document_id" BIGINT NOT NULL,
        "chunk_index" INT NOT NULL,
        "content" TEXT NOT NULL,
        "content_length" INT NOT NULL DEFAULT 0,
        "embedding" vector(1024),
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_document_chunk_document_id"
      ON "kh_document_chunk" ("document_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_document_chunk_document_id"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "kh_document_chunk"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_document_task_status_created"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "kh_document_task"`);
    await queryRunner.query(`
      ALTER TABLE "kh_document"
      DROP COLUMN IF EXISTS "file_ext",
      DROP COLUMN IF EXISTS "file_size",
      DROP COLUMN IF EXISTS "file_url"
    `);
  }
}
