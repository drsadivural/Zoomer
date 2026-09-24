CREATE TABLE `identity_verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`session_id` text NOT NULL,
	`participant_id` text NOT NULL,
	`trainee_id` text,
	`result` text NOT NULL,
	`confidence` real,
	`threshold` real,
	`engine` text,
	`model_version` text,
	`source` text DEFAULT 'BOT' NOT NULL,
	`trigger` text DEFAULT 'PERIODIC' NOT NULL,
	`reason` text,
	`evidence_id` text,
	`verified_at` integer NOT NULL,
	`expires_at` integer
);
--> statement-breakpoint
CREATE INDEX `idv_session_time_idx` ON `identity_verifications` (`session_id`,`verified_at`);--> statement-breakpoint
CREATE INDEX `idv_participant_idx` ON `identity_verifications` (`participant_id`,`verified_at`);--> statement-breakpoint
CREATE TABLE `meeting_analysis_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`session_id` text NOT NULL,
	`zoom_meeting_id` text,
	`adapter` text DEFAULT 'MOCK' NOT NULL,
	`status` text DEFAULT 'STARTING' NOT NULL,
	`config` text,
	`started_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`stopped_at` integer,
	`started_by` text,
	`last_heartbeat_at` integer,
	`participant_count` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mas_org_session_idx` ON `meeting_analysis_sessions` (`organization_id`,`session_id`);--> statement-breakpoint
CREATE INDEX `mas_org_status_idx` ON `meeting_analysis_sessions` (`organization_id`,`status`);--> statement-breakpoint
CREATE INDEX `mas_zoom_meeting_idx` ON `meeting_analysis_sessions` (`zoom_meeting_id`);--> statement-breakpoint
CREATE TABLE `meeting_monitoring_settings` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`face_monitoring_enabled` integer DEFAULT true NOT NULL,
	`identity_verification_enabled` integer DEFAULT true NOT NULL,
	`screen_facing_enabled` integer DEFAULT true NOT NULL,
	`head_pose_enabled` integer DEFAULT true NOT NULL,
	`multi_face_enabled` integer DEFAULT true NOT NULL,
	`participation_analytics_enabled` integer DEFAULT true NOT NULL,
	`transcript_enabled` integer DEFAULT false NOT NULL,
	`normal_fps` real DEFAULT 2 NOT NULL,
	`elevated_fps` real DEFAULT 5 NOT NULL,
	`normal_interval_sec` integer DEFAULT 10 NOT NULL,
	`warm_interval_sec` integer DEFAULT 3 NOT NULL,
	`hot_interval_sec` integer DEFAULT 1 NOT NULL,
	`transient_sec` integer DEFAULT 3 NOT NULL,
	`temporary_sec` integer DEFAULT 10 NOT NULL,
	`prolonged_sec` integer DEFAULT 30 NOT NULL,
	`face_missing_sec` integer DEFAULT 30 NOT NULL,
	`screen_away_sec` integer DEFAULT 30 NOT NULL,
	`camera_off_sec` integer DEFAULT 60 NOT NULL,
	`multi_face_sec` integer DEFAULT 5 NOT NULL,
	`long_absence_sec` integer DEFAULT 300 NOT NULL,
	`identity_confidence_threshold` real DEFAULT 0.82 NOT NULL,
	`identity_cache_sec` integer DEFAULT 600 NOT NULL,
	`screen_facing_threshold` real DEFAULT 0.6 NOT NULL,
	`low_confidence_threshold` real DEFAULT 0.4 NOT NULL,
	`yaw_threshold_deg` real DEFAULT 25 NOT NULL,
	`pitch_up_threshold_deg` real DEFAULT 18 NOT NULL,
	`pitch_down_threshold_deg` real DEFAULT 22 NOT NULL,
	`snapshots_enabled` integer DEFAULT false NOT NULL,
	`snapshot_retention_days` integer DEFAULT 7 NOT NULL,
	`observation_retention_days` integer DEFAULT 14 NOT NULL,
	`event_retention_days` integer DEFAULT 90 NOT NULL,
	`transcript_retention_days` integer DEFAULT 30 NOT NULL,
	`alert_notifications_enabled` integer DEFAULT true NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_by` text
);
--> statement-breakpoint
CREATE TABLE `meeting_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`session_id` text NOT NULL,
	`analysis_session_id` text,
	`summary` text NOT NULL,
	`participants` text NOT NULL,
	`generated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`generated_by` text
);
--> statement-breakpoint
CREATE INDEX `mr_org_session_idx` ON `meeting_reports` (`organization_id`,`session_id`,`generated_at`);--> statement-breakpoint
CREATE TABLE `participant_analysis_state` (
	`participant_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`session_id` text NOT NULL,
	`analysis_session_id` text,
	`display_name` text,
	`joined_at` integer,
	`left_at` integer,
	`camera_on` integer DEFAULT false NOT NULL,
	`microphone_on` integer DEFAULT false NOT NULL,
	`speaking` integer DEFAULT false NOT NULL,
	`speaking_ms` integer DEFAULT 0 NOT NULL,
	`speaking_turns` integer DEFAULT 0 NOT NULL,
	`last_spoke_at` integer,
	`face_detected` integer DEFAULT false NOT NULL,
	`face_count` integer DEFAULT 0 NOT NULL,
	`face_box` text,
	`identity_status` text DEFAULT 'UNKNOWN' NOT NULL,
	`identity_confidence` real,
	`identity_trainee_id` text,
	`identity_verified_at` integer,
	`identity_expires_at` integer,
	`head_yaw` real,
	`head_pitch` real,
	`head_roll` real,
	`head_state` text DEFAULT 'UNKNOWN' NOT NULL,
	`screen_facing_probability` real,
	`gaze_horizontal` real,
	`gaze_vertical` real,
	`current_state` text DEFAULT 'UNKNOWN' NOT NULL,
	`current_state_since` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`pending_state` text,
	`pending_state_since` integer,
	`last_analyzed_at` integer,
	`analysis_confidence` real,
	`analysis_tier` text DEFAULT 'NORMAL' NOT NULL,
	`next_analysis_at` integer,
	`thumbnail_evidence_id` text,
	`thumbnail_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pas_org_session_idx` ON `participant_analysis_state` (`organization_id`,`session_id`);--> statement-breakpoint
CREATE INDEX `pas_session_state_idx` ON `participant_analysis_state` (`session_id`,`current_state`);--> statement-breakpoint
CREATE INDEX `pas_schedule_idx` ON `participant_analysis_state` (`session_id`,`analysis_tier`,`next_analysis_at`);--> statement-breakpoint
CREATE TABLE `participant_engagement_events` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`session_id` text NOT NULL,
	`participant_id` text NOT NULL,
	`type` text NOT NULL,
	`severity` text DEFAULT 'INFO' NOT NULL,
	`state` text DEFAULT 'OPEN' NOT NULL,
	`started_at` integer NOT NULL,
	`resolved_at` integer,
	`duration_ms` integer,
	`confidence` real,
	`detail` text,
	`dedupe_key` text NOT NULL,
	`occurrences` integer DEFAULT 1 NOT NULL,
	`evidence_id` text,
	`alert_id` text,
	`escalated` integer DEFAULT false NOT NULL,
	`expires_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pee_session_time_idx` ON `participant_engagement_events` (`session_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `pee_participant_idx` ON `participant_engagement_events` (`participant_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `pee_org_state_idx` ON `participant_engagement_events` (`organization_id`,`state`);--> statement-breakpoint
CREATE UNIQUE INDEX `pee_open_dedupe_uq` ON `participant_engagement_events` (`participant_id`,`dedupe_key`,`started_at`);--> statement-breakpoint
CREATE TABLE `participant_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`session_id` text NOT NULL,
	`participant_id` text NOT NULL,
	`observed_at` integer NOT NULL,
	`face_detected` integer DEFAULT false NOT NULL,
	`face_count` integer DEFAULT 0 NOT NULL,
	`identity_status` text,
	`recognition_confidence` real,
	`head_yaw` real,
	`head_pitch` real,
	`head_roll` real,
	`screen_facing_probability` real,
	`camera_on` integer,
	`microphone_on` integer,
	`speaking` integer,
	`state` text DEFAULT 'UNKNOWN' NOT NULL,
	`confidence` real,
	`source` text DEFAULT 'BOT' NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `obs_session_time_idx` ON `participant_observations` (`session_id`,`observed_at`);--> statement-breakpoint
CREATE INDEX `obs_participant_time_idx` ON `participant_observations` (`participant_id`,`observed_at`);--> statement-breakpoint
CREATE INDEX `obs_expiry_idx` ON `participant_observations` (`expires_at`);