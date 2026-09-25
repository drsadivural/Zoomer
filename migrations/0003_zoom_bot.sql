-- Zoom Meeting-SDK bot support.
--
-- Additive only: two settings columns, both defaulting to the behaviour that
-- makes a freshly connected Zoom account work without further configuration.
-- No existing column, index or row is touched.

ALTER TABLE meeting_monitoring_settings ADD COLUMN auto_session_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE meeting_monitoring_settings ADD COLUMN bot_auto_join_enabled INTEGER NOT NULL DEFAULT 1;
