-- Opt-in applies only to assets inserted after enabling it. Never backfill old assets,
-- including when upgrading an installation whose switch is already enabled.
CREATE TABLE local_auto_classification_pending (
  asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE
);

CREATE TRIGGER local_auto_classification_new_asset AFTER INSERT ON assets
WHEN (SELECT enabled FROM local_classification_state WHERE id=1)=1
BEGIN
  INSERT OR IGNORE INTO local_auto_classification_pending(asset_id) VALUES(NEW.id);
END;

CREATE TRIGGER local_auto_classification_toggle AFTER UPDATE OF enabled ON local_classification_state
WHEN OLD.enabled<>NEW.enabled
BEGIN
  DELETE FROM local_auto_classification_pending;
END;

CREATE TRIGGER local_auto_classification_observed AFTER INSERT ON local_visual_observations
BEGIN
  DELETE FROM local_auto_classification_pending WHERE asset_id=NEW.asset_id;
END;
CREATE TRIGGER local_auto_classification_observed_update AFTER UPDATE ON local_visual_observations
BEGIN
  DELETE FROM local_auto_classification_pending WHERE asset_id=NEW.asset_id;
END;
