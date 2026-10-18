-- Durable export work: metadata changes commit with the image record.
CREATE TABLE creative_file_queue (
  asset_id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  source_path TEXT,
  error TEXT
);
CREATE TRIGGER creative_assets_insert AFTER INSERT ON assets BEGIN
  INSERT INTO creative_file_queue(asset_id,token,source_path) VALUES(NEW.id,hex(randomblob(16)),NEW.store_path)
  ON CONFLICT(asset_id) DO UPDATE SET token=excluded.token,source_path=excluded.source_path,error=NULL;
END;
CREATE TRIGGER creative_assets_update AFTER UPDATE ON assets BEGIN
  INSERT INTO creative_file_queue(asset_id,token,source_path) VALUES(NEW.id,hex(randomblob(16)),NEW.store_path)
  ON CONFLICT(asset_id) DO UPDATE SET token=excluded.token,source_path=excluded.source_path,error=NULL;
END;
CREATE TRIGGER creative_assets_delete AFTER DELETE ON assets BEGIN
  INSERT INTO creative_file_queue(asset_id,token,source_path) VALUES(OLD.id,hex(randomblob(16)),OLD.store_path)
  ON CONFLICT(asset_id) DO UPDATE SET token=excluded.token,source_path=excluded.source_path,error=NULL;
END;
CREATE TRIGGER creative_analyses_insert AFTER INSERT ON analyses BEGIN
  INSERT INTO creative_file_queue(asset_id,token,source_path) VALUES(NEW.asset_id,hex(randomblob(16)),(SELECT store_path FROM assets WHERE id=NEW.asset_id))
  ON CONFLICT(asset_id) DO UPDATE SET token=excluded.token,source_path=excluded.source_path,error=NULL;
END;
CREATE TRIGGER creative_analyses_update AFTER UPDATE ON analyses BEGIN
  INSERT INTO creative_file_queue(asset_id,token,source_path) VALUES(NEW.asset_id,hex(randomblob(16)),(SELECT store_path FROM assets WHERE id=NEW.asset_id))
  ON CONFLICT(asset_id) DO UPDATE SET token=excluded.token,source_path=excluded.source_path,error=NULL;
END;
CREATE TRIGGER creative_analyses_delete AFTER DELETE ON analyses BEGIN
  INSERT INTO creative_file_queue(asset_id,token,source_path) VALUES(OLD.asset_id,hex(randomblob(16)),(SELECT store_path FROM assets WHERE id=OLD.asset_id))
  ON CONFLICT(asset_id) DO UPDATE SET token=excluded.token,source_path=excluded.source_path,error=NULL;
END;
CREATE TRIGGER creative_asset_tags_insert AFTER INSERT ON asset_tags BEGIN
  INSERT INTO creative_file_queue(asset_id,token,source_path) VALUES(NEW.asset_id,hex(randomblob(16)),(SELECT store_path FROM assets WHERE id=NEW.asset_id))
  ON CONFLICT(asset_id) DO UPDATE SET token=excluded.token,source_path=excluded.source_path,error=NULL;
END;
CREATE TRIGGER creative_asset_tags_update AFTER UPDATE ON asset_tags BEGIN
  INSERT INTO creative_file_queue(asset_id,token,source_path) VALUES(NEW.asset_id,hex(randomblob(16)),(SELECT store_path FROM assets WHERE id=NEW.asset_id))
  ON CONFLICT(asset_id) DO UPDATE SET token=excluded.token,source_path=excluded.source_path,error=NULL;
END;
CREATE TRIGGER creative_asset_tags_delete AFTER DELETE ON asset_tags BEGIN
  INSERT INTO creative_file_queue(asset_id,token,source_path) VALUES(OLD.asset_id,hex(randomblob(16)),(SELECT store_path FROM assets WHERE id=OLD.asset_id))
  ON CONFLICT(asset_id) DO UPDATE SET token=excluded.token,source_path=excluded.source_path,error=NULL;
END;
CREATE TRIGGER creative_asset_prompts_insert AFTER INSERT ON asset_prompts BEGIN
  INSERT INTO creative_file_queue(asset_id,token,source_path) VALUES(NEW.asset_id,hex(randomblob(16)),(SELECT store_path FROM assets WHERE id=NEW.asset_id))
  ON CONFLICT(asset_id) DO UPDATE SET token=excluded.token,source_path=excluded.source_path,error=NULL;
END;
CREATE TRIGGER creative_asset_prompts_update AFTER UPDATE ON asset_prompts BEGIN
  INSERT INTO creative_file_queue(asset_id,token,source_path) VALUES(NEW.asset_id,hex(randomblob(16)),(SELECT store_path FROM assets WHERE id=NEW.asset_id))
  ON CONFLICT(asset_id) DO UPDATE SET token=excluded.token,source_path=excluded.source_path,error=NULL;
END;
CREATE TRIGGER creative_asset_prompts_delete AFTER DELETE ON asset_prompts BEGIN
  INSERT INTO creative_file_queue(asset_id,token,source_path) VALUES(OLD.asset_id,hex(randomblob(16)),(SELECT store_path FROM assets WHERE id=OLD.asset_id))
  ON CONFLICT(asset_id) DO UPDATE SET token=excluded.token,source_path=excluded.source_path,error=NULL;
END;
CREATE TRIGGER creative_tags_update AFTER UPDATE ON tags BEGIN
  INSERT INTO creative_file_queue(asset_id,token,source_path)
  SELECT a.id,hex(randomblob(16)),a.store_path FROM assets a JOIN asset_tags j ON j.asset_id=a.id WHERE j.tag_id=NEW.id
  ON CONFLICT(asset_id) DO UPDATE SET token=excluded.token,source_path=excluded.source_path,error=NULL;
END;
CREATE TRIGGER creative_prompts_update AFTER UPDATE ON prompts BEGIN
  INSERT INTO creative_file_queue(asset_id,token,source_path)
  SELECT a.id,hex(randomblob(16)),a.store_path FROM assets a JOIN asset_prompts j ON j.asset_id=a.id WHERE j.prompt_id=NEW.id
  ON CONFLICT(asset_id) DO UPDATE SET token=excluded.token,source_path=excluded.source_path,error=NULL;
END;
