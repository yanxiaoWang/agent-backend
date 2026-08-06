import { MigrationInterface, QueryRunner } from 'typeorm';

export class ConversationUpdatedAtAndIndexes1785903000000
  implements MigrationInterface
{
  name = 'ConversationUpdatedAtAndIndexes1785903000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "conversations"
      ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_messages_conversation_created"
      ON "messages" ("conversation_id", "created_at")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_conversations_user_updated"
      ON "conversations" ("user_id", "updated_at" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_conversations_user_updated"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_messages_conversation_created"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP COLUMN IF EXISTS "updated_at"`,
    );
  }
}
