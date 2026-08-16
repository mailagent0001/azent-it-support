CREATE TABLE IF NOT EXISTS diagnosis_trees (
  tree_id       TEXT PRIMARY KEY,
  device_type   TEXT NOT NULL,
  maker         TEXT DEFAULT '共通',
  model_pattern TEXT DEFAULT '共通',
  tree_json     TEXT NOT NULL,
  is_verified   INTEGER DEFAULT 1,
  updated_at    TEXT
);
