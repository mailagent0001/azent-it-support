-- グループLINE対応マイグレーション
-- companies テーブルに group_line_id を追加
-- 実行コマンド: wrangler d1 execute azent-support-db --file=0002_add_group_line.sql

ALTER TABLE companies ADD COLUMN group_line_id TEXT;

-- インデックス追加(検索高速化)
CREATE INDEX IF NOT EXISTS idx_companies_group_line_id ON companies(group_line_id);
CREATE INDEX IF NOT EXISTS idx_companies_approver_line_id ON companies(approver_line_id);
