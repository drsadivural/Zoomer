-- Optional stored thumbnail for a face enrollment.
--
-- Additive only. The feature is OFF by default: with
-- enrollment_thumbnails_enabled = 0 nothing is written to these columns and
-- the product's behaviour is unchanged — encrypted templates only, no image.
--
-- `image_key` already existed on face_enrollments and was never written; it now
-- holds the R2 key of the encrypted thumbnail. The two new columns carry the
-- integrity hash and media type, matching how evidence_objects records them.

ALTER TABLE face_enrollments ADD COLUMN image_sha256 TEXT;
ALTER TABLE face_enrollments ADD COLUMN image_content_type TEXT;

ALTER TABLE meeting_monitoring_settings
  ADD COLUMN enrollment_thumbnails_enabled INTEGER NOT NULL DEFAULT 0;
