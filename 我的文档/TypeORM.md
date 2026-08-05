# NestJS TypeORM 多人协作开发策略

核心结论：本地开发统一关闭 `synchronize: true`，全员本地跑 migration，不依靠自动同步表结构，这是多人团队标准做法。

## 新增 / 修改 Entity 后如何落到数据库

1. 写好 `*.entity.ts`，并在 `app.module.ts` 与根目录 `data-source.ts` 的 `entities` 数组中注册
2. 生成迁移（对比 Entity 与当前库结构）：

```bash
npm run migration:generate -- src/migrations/描述变更
```

3. 执行迁移：

```bash
npm run migration:run
```

4. 查看状态 / 回滚上一版：

```bash
npm run migration:show
npm run migration:revert
```

CLI 使用根目录 `data-source.ts`，连接配置与 `AppModule` 一致（默认对接 docker-compose 的 Postgres）。
