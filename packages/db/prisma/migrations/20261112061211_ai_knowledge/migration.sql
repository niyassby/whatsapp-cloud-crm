-- pgvector for knowledge base embeddings. Needs the extension installed on the server
-- (the Docker and CI images have it; see infra/native-setup.md for Windows).
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "ai_settings" (
    "org_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "inbox_assist" BOOLEAN NOT NULL DEFAULT true,
    "auto_reply" BOOLEAN NOT NULL DEFAULT false,
    "min_confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "instructions" TEXT NOT NULL DEFAULT '',
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ai_settings_pkey" PRIMARY KEY ("org_id")
);

-- CreateTable
CREATE TABLE "knowledge_documents" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "mime_type" TEXT,
    "size_bytes" INTEGER NOT NULL DEFAULT 0,
    "file_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "chunk_count" INTEGER NOT NULL DEFAULT 0,
    "embedding_model" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "knowledge_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_chunks" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "tokens" INTEGER NOT NULL,
    "embedding" vector(1024) NOT NULL,
    "embedding_model" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_logs" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "conversation_id" UUID,
    "flow_run_id" UUID,
    "user_id" UUID,
    "input" TEXT NOT NULL,
    "output" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "sources" JSONB NOT NULL DEFAULT '[]',
    "sent" BOOLEAN NOT NULL DEFAULT false,
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "cost_micros" BIGINT NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "knowledge_documents_org_id_created_at_idx" ON "knowledge_documents"("org_id", "created_at");

-- CreateIndex
CREATE INDEX "knowledge_chunks_org_id_embedding_model_idx" ON "knowledge_chunks"("org_id", "embedding_model");

-- CreateIndex
CREATE INDEX "knowledge_chunks_document_id_idx" ON "knowledge_chunks"("document_id");

-- CreateIndex
CREATE INDEX "ai_logs_org_id_created_at_idx" ON "ai_logs"("org_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_logs_org_id_kind_created_at_idx" ON "ai_logs"("org_id", "kind", "created_at");

-- AddForeignKey
ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "knowledge_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_logs" ADD CONSTRAINT "ai_logs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ------------------------------------------------------------------ grants

-- Settings are kept, never deleted.
GRANT SELECT, INSERT, UPDATE ON ai_settings TO app_user;
REVOKE DELETE, TRUNCATE ON ai_settings FROM app_user;
-- Documents are soft-deleted; their passages are replaced on reindex and removed on delete.
GRANT SELECT, INSERT, UPDATE ON knowledge_documents TO app_user;
REVOKE DELETE, TRUNCATE ON knowledge_documents FROM app_user;
GRANT SELECT, INSERT, DELETE ON knowledge_chunks TO app_user;
REVOKE UPDATE, TRUNCATE ON knowledge_chunks FROM app_user;
-- The AI log only grows.
GRANT SELECT, INSERT ON ai_logs TO app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON ai_logs FROM app_user;

-- ------------------------------------------------------------------ row level security

ALTER TABLE ai_settings         ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_settings         FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_chunks    ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_chunks    FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_logs             ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_logs             FORCE ROW LEVEL SECURITY;

CREATE POLICY ai_settings_org ON ai_settings FOR ALL TO app_user
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());
CREATE POLICY knowledge_documents_org ON knowledge_documents FOR ALL TO app_user
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());
CREATE POLICY knowledge_chunks_org ON knowledge_chunks FOR ALL TO app_user
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());
CREATE POLICY ai_logs_org ON ai_logs FOR ALL TO app_user
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());

-- Every stored vector has the size the column was made for.
ALTER TABLE knowledge_chunks ADD CONSTRAINT knowledge_chunks_embedding_finite
  CHECK (vector_dims(embedding) = 1024);

-- ------------------------------------------------------------------ plans

UPDATE plans SET features = features || '["ai"]'::jsonb
  WHERE code IN ('growth', 'scale') AND NOT features ? 'ai';
