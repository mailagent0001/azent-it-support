-- =============================================
-- A-Zent IT保守サブスク D1データベース初期構築
-- =============================================

-- 会社マスタ
CREATE TABLE IF NOT EXISTS companies (
  company_id    TEXT PRIMARY KEY,
  company_name  TEXT NOT NULL,
  address       TEXT,
  plan          TEXT,
  monthly_fee   INTEGER,
  contract_date TEXT,
  approver_name TEXT,
  approver_tel  TEXT,
  approver_line_id TEXT,
  notes         TEXT
);

-- 機器台帳
CREATE TABLE IF NOT EXISTS devices (
  device_id     TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL,
  device_type   TEXT NOT NULL,
  maker         TEXT,
  model         TEXT,
  serial        TEXT,
  location      TEXT,
  install_date  TEXT,
  notes         TEXT,
  FOREIGN KEY (company_id) REFERENCES companies(company_id)
);

-- 共通ナレッジDB
CREATE TABLE IF NOT EXISTS knowledge (
  knowledge_id        TEXT PRIMARY KEY,
  device_type         TEXT NOT NULL,
  maker               TEXT DEFAULT '共通',
  model_pattern       TEXT DEFAULT '共通',
  symptom_keywords    TEXT NOT NULL,
  diagnosis           TEXT,
  fix                 TEXT,
  escalation_criteria TEXT,
  updated_at          TEXT,
  updated_by          TEXT,
  notes               TEXT
);

-- 単価表マスタ
CREATE TABLE IF NOT EXISTS pricing (
  item_id         TEXT PRIMARY KEY,
  device_type     TEXT,
  item_name       TEXT NOT NULL,
  amount          INTEGER NOT NULL,
  unit            TEXT,
  approval_flag   TEXT DEFAULT '自動承認',
  notes           TEXT
);

-- 業者マスタ
CREATE TABLE IF NOT EXISTS vendors (
  vendor_id      TEXT PRIMARY KEY,
  vendor_name    TEXT NOT NULL,
  area           TEXT,
  device_types   TEXT,
  priority       INTEGER NOT NULL,
  line_id        TEXT,
  phone          TEXT,
  notes          TEXT
);

-- ディスパッチログ
CREATE TABLE IF NOT EXISTS dispatch_log (
  dispatch_id    TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL,
  symptom        TEXT,
  matched_status TEXT,
  vendor_id      TEXT,
  dispatched_at  TEXT,
  responded_at   TEXT,
  status         TEXT DEFAULT 'pending',
  report         TEXT,
  total_amount   INTEGER,
  approved_by    TEXT,
  notes          TEXT
);

-- アンケートログ
CREATE TABLE IF NOT EXISTS survey_log (
  survey_id      TEXT PRIMARY KEY,
  dispatch_id    TEXT NOT NULL,
  company_id     TEXT NOT NULL,
  vendor_id      TEXT,
  q_speed        INTEGER,
  q_manner       INTEGER,
  q_resolved     TEXT,
  q_reuse        TEXT,
  q_comment      TEXT,
  answered_at    TEXT,
  FOREIGN KEY (dispatch_id) REFERENCES dispatch_log(dispatch_id)
);

-- サンプルデータ(動作確認用 - 本番では削除)
INSERT OR IGNORE INTO companies VALUES
  ('C001','(サンプル)株式会社おきなわ商事','那覇市〇〇1-2-3','スタンダード',30000,'2026-09-01','山田太郎','090-0000-0000','line_id_sample','記入例');

INSERT OR IGNORE INTO devices VALUES
  ('D001','C001','PC','Dell','OptiPlex 7010','SN-001','受付カウンター','2023-04-01','記入例'),
  ('D002','C001','プリンタ','Canon','iR-ADV C3830','SN-002','事務所内','2022-10-01','記入例'),
  ('D003','C001','LAN機器','Buffalo','BHR-4GRV2','SN-003','サーバールーム','2024-01-15','記入例');

INSERT OR IGNORE INTO knowledge VALUES
  ('K001','プリンタ','Canon','iR-ADV C3830','紙づまり;紙が詰まる','トレイの種類と詰まった場所を確認','カバーを開け詰まった用紙をゆっくり両手で引き抜く→カバーを閉めて再起動','3回試しても取れない;異音;異臭','2026-08-06','初期登録','型番専用'),
  ('K002','プリンタ','共通','共通','紙づまり;紙が詰まる','トレイの種類と詰まった場所を確認','カバーを開け詰まった用紙をゆっくり引き抜く→再起動','3回試しても取れない','2026-08-06','初期登録','汎用フォールバック'),
  ('K003','PC','共通','共通','起動しない;電源が入らない','電源ケーブル・タップの通電確認','電源ケーブルを挿し直す→別のコンセントで試す→放電(60秒)','放電しても起動しない;異音;焦げ臭い','2026-08-06','初期登録','汎用'),
  ('K004','PC','共通','共通','動作が遅い','起動中のアプリ数・空き容量を確認','不要なアプリを終了→再起動→ディスク空き容量確認','再起動後も改善しない','2026-08-06','初期登録','汎用'),
  ('K005','LAN機器','Buffalo','BHR-4GRV2','ネットにつながらない;wifiが切れる','ランプの点灯状況を確認','電源を抜いて30秒待って再起動→LANケーブルの挿し直し','再起動しても復旧しない;複数台で同時に発生','2026-08-06','初期登録','型番専用'),
  ('K006','LAN機器','共通','共通','ネットにつながらない;wifiが切れる','ランプの点灯状況を確認','電源を抜いて30秒待って再起動','再起動しても復旧しない','2026-08-06','初期登録','汎用フォールバック');

INSERT OR IGNORE INTO pricing VALUES
  ('P001','PC','出張基本料(訪問のみ)',7000,'回','自動承認',''),
  ('P002','PC','HDD/SSD交換(部品代別)',8000,'回','自動承認',''),
  ('P003','PC','データ復旧作業',15000,'回','決裁者承認','金額が大きいため承認必須'),
  ('P004','PC','OS再インストール',10000,'回','決裁者承認',''),
  ('P005','プリンタ','出張基本料(訪問のみ)',7000,'回','自動承認',''),
  ('P006','プリンタ','トナー/ドラム交換(部品代別)',5000,'回','自動承認',''),
  ('P007','プリンタ','基板故障の修理',20000,'回','決裁者承認',''),
  ('P008','LAN機器','出張基本料(訪問のみ)',7000,'回','自動承認',''),
  ('P009','LAN機器','ルーター/スイッチ交換(本体代別)',6000,'回','自動承認',''),
  ('P010','共通','部品代(実費)',0,'実費','決裁者承認','10000円超は必ず事前承認');

INSERT OR IGNORE INTO vendors VALUES
  ('V001','(サンプル)PCサポート119番','那覇市;豊見城市;糸満市;南城市','PC;プリンタ;LAN機器',1,'line_id_v001','098-000-0001','南部拠点あり'),
  ('V002','(サンプル)パソコンドック24那覇店','那覇市;浦添市','PC;プリンタ',2,'line_id_v002','098-000-0002',''),
  ('V003','(サンプル)個人事業主A','那覇市以南全域','PC',3,'line_id_v003','090-0000-0003','予備枠');
