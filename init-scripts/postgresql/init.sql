CREATE EXTENSION IF NOT EXISTS vector;

-- 文档元数据表
CREATE TABLE IF NOT EXISTS kh_document (
    id BIGINT PRIMARY KEY,
    title VARCHAR NOT NULL,
    content_id VARCHAR NOT NULL UNIQUE,
    summary VARCHAR,
    category_id BIGINT,
    team_id BIGINT,
    author_id BIGINT,
    cover_image VARCHAR,
    file_url VARCHAR,
    file_size INT NOT NULL DEFAULT 0,
    file_ext VARCHAR,
    tags VARCHAR,
    status SMALLINT NOT NULL DEFAULT 0,
    remark VARCHAR,
    view_count INT NOT NULL DEFAULT 0,
    like_count INT NOT NULL DEFAULT 0,
    comment_count INT NOT NULL DEFAULT 0,
    favourite_count INT NOT NULL DEFAULT 0,
    word_count INT NOT NULL DEFAULT 0,
    publish_time TIMESTAMP,
    is_public BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    create_by BIGINT,
    update_by BIGINT,
    deleted BOOLEAN NOT NULL DEFAULT false
);

-- 文档异步任务表
CREATE TABLE IF NOT EXISTS kh_document_task (
    id BIGINT PRIMARY KEY,
    status VARCHAR(32) NOT NULL DEFAULT 'queued',
    progress SMALLINT NOT NULL DEFAULT 0,
    step VARCHAR(128),
    document_id BIGINT,
    file_name VARCHAR NOT NULL,
    file_ext VARCHAR(32) NOT NULL,
    file_size INT NOT NULL DEFAULT 0,
    content_type VARCHAR,
    file_url VARCHAR,
    file_key VARCHAR,
    meta JSONB,
    error_message TEXT,
    create_by BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_document_task_status_created
ON kh_document_task (status, created_at);

-- 文档分块 + pgvector
CREATE TABLE IF NOT EXISTS kh_document_chunk (
    id BIGINT PRIMARY KEY,
    document_id BIGINT NOT NULL,
    chunk_index INT NOT NULL,
    content TEXT NOT NULL,
    content_length INT NOT NULL DEFAULT 0,
    embedding vector(1024),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_document_chunk_document_id
ON kh_document_chunk (document_id);
