# NestJS TypeORM 多人协作开发策略
核心结论：本地开发统一关闭 synchronize: true，全员本地跑 migration，不依靠自动同步表结构，这是多人团队标准做法

-Migration 迁移文件（migration:generate + migration:run）
