-- 到着予定時間(分)を記録する列を追加
ALTER TABLE dispatch_log ADD COLUMN eta_minutes INTEGER;
