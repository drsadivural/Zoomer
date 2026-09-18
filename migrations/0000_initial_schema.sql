CREATE TABLE `alert_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`alert_id` text NOT NULL,
	`reviewer_id` text NOT NULL,
	`action` text NOT NULL,
	`reason_code` text,
	`comment` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `alert_reviews_org_alert_idx` ON `alert_reviews` (`organization_id`,`alert_id`);--> statement-breakpoint
CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`session_id` text NOT NULL,
	`participant_id` text NOT NULL,
	`type` text NOT NULL,
	`severity` text NOT NULL,
	`state` text DEFAULT 'OPEN' NOT NULL,
	`summary` text NOT NULL,
	`detail` text,
	`first_event_id` text,
	`last_event_id` text,
	`evidence_id` text,
	`occurrences` integer DEFAULT 1 NOT NULL,
	`rule_version` text,
	`model_version` text,
	`assigned_to` text,
	`dedupe_key` text,
	`opened_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`closed_at` integer,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `alerts_org_session_idx` ON `alerts` (`organization_id`,`session_id`,`opened_at`);--> statement-breakpoint
CREATE INDEX `alerts_org_state_idx` ON `alerts` (`organization_id`,`state`);--> statement-breakpoint
CREATE UNIQUE INDEX `alerts_dedupe_uq` ON `alerts` (`session_id`,`dedupe_key`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`actor_id` text,
	`actor_type` text DEFAULT 'user' NOT NULL,
	`action` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text,
	`result` text DEFAULT 'SUCCESS' NOT NULL,
	`metadata` text,
	`request_id` text,
	`ip_hash` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_logs_org_created_idx` ON `audit_logs` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_logs_org_resource_idx` ON `audit_logs` (`organization_id`,`resource_type`,`resource_id`);--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_sessions_token_uq` ON `auth_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `auth_sessions_user_idx` ON `auth_sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `consents` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`trainee_id` text NOT NULL,
	`session_id` text,
	`policy_version` text NOT NULL,
	`scope` text NOT NULL,
	`granted_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`revoked_at` integer,
	`user_agent` text
);
--> statement-breakpoint
CREATE INDEX `consents_org_trainee_idx` ON `consents` (`organization_id`,`trainee_id`);--> statement-breakpoint
CREATE TABLE `evidence_objects` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`session_id` text NOT NULL,
	`participant_id` text NOT NULL,
	`object_key` text NOT NULL,
	`content_type` text DEFAULT 'image/jpeg' NOT NULL,
	`byte_size` integer,
	`sha256` text NOT NULL,
	`kind` text NOT NULL,
	`captured_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`deleted_at` integer,
	`delete_reason` text
);
--> statement-breakpoint
CREATE INDEX `evidence_org_session_idx` ON `evidence_objects` (`organization_id`,`session_id`);--> statement-breakpoint
CREATE INDEX `evidence_expiry_idx` ON `evidence_objects` (`expires_at`,`deleted_at`);--> statement-breakpoint
CREATE TABLE `face_enrollments` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`trainee_id` text NOT NULL,
	`template` text NOT NULL,
	`template_iv` text NOT NULL,
	`engine` text NOT NULL,
	`model_version` text NOT NULL,
	`dimensions` integer NOT NULL,
	`quality_score` real NOT NULL,
	`quality_detail` text,
	`image_key` text,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`created_by` text,
	`deleted_at` integer,
	`deleted_by` text
);
--> statement-breakpoint
CREATE INDEX `face_enrollments_org_trainee_idx` ON `face_enrollments` (`organization_id`,`trainee_id`);--> statement-breakpoint
CREATE INDEX `face_enrollments_org_status_idx` ON `face_enrollments` (`organization_id`,`status`);--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`key` text NOT NULL,
	`endpoint` text NOT NULL,
	`request_hash` text NOT NULL,
	`status_code` integer,
	`response_body` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idempotency_org_key_uq` ON `idempotency_keys` (`organization_id`,`key`,`endpoint`);--> statement-breakpoint
CREATE TABLE `integrations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`provider` text NOT NULL,
	`status` text DEFAULT 'DISCONNECTED' NOT NULL,
	`access_token` text,
	`access_token_iv` text,
	`refresh_token` text,
	`refresh_token_iv` text,
	`expires_at` integer,
	`scope` text,
	`account_id` text,
	`config` text,
	`connected_by` text,
	`connected_at` integer,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integrations_org_provider_uq` ON `integrations` (`organization_id`,`provider`);--> statement-breakpoint
CREATE TABLE `monitoring_events` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`session_id` text NOT NULL,
	`participant_id` text NOT NULL,
	`type` text NOT NULL,
	`severity` text NOT NULL,
	`captured_at` integer NOT NULL,
	`received_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`duration_ms` integer,
	`face_count` integer,
	`match_score` real,
	`quality_score` real,
	`model_version` text,
	`rule_version` text,
	`evidence_id` text,
	`server_adjusted` integer DEFAULT false NOT NULL,
	`quarantined` integer DEFAULT false NOT NULL,
	`quarantine_reason` text
);
--> statement-breakpoint
CREATE INDEX `monitoring_events_org_session_idx` ON `monitoring_events` (`organization_id`,`session_id`,`captured_at`);--> statement-breakpoint
CREATE INDEX `monitoring_events_participant_idx` ON `monitoring_events` (`participant_id`,`captured_at`);--> statement-breakpoint
CREATE INDEX `monitoring_events_org_type_idx` ON `monitoring_events` (`organization_id`,`type`);--> statement-breakpoint
CREATE TABLE `monitoring_settings` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`reauth_interval_sec` integer DEFAULT 60 NOT NULL,
	`match_threshold` real DEFAULT 0.82 NOT NULL,
	`absence_sec` integer DEFAULT 60 NOT NULL,
	`eyes_closed_sec` integer DEFAULT 10 NOT NULL,
	`multi_face_frames` integer DEFAULT 15 NOT NULL,
	`evidence_interval_sec` integer DEFAULT 300 NOT NULL,
	`evidence_retention_days` integer DEFAULT 30 NOT NULL,
	`precheck_max_attempts` integer DEFAULT 3 NOT NULL,
	`liveness_required` integer DEFAULT true NOT NULL,
	`image_quality` real DEFAULT 0.72 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_by` text
);
--> statement-breakpoint
CREATE TABLE `notification_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`event_types` text NOT NULL,
	`min_severity` text DEFAULT 'ALERT' NOT NULL,
	`channel` text NOT NULL,
	`target` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notification_rules_org_idx` ON `notification_rules` (`organization_id`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`timezone` text DEFAULT 'Asia/Tokyo' NOT NULL,
	`locale` text DEFAULT 'ja' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE TABLE `reports` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`params` text,
	`object_key` text,
	`row_count` integer,
	`error` text,
	`requested_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`completed_at` integer,
	`expires_at` integer
);
--> statement-breakpoint
CREATE INDEX `reports_org_created_idx` ON `reports` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `session_participants` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`session_id` text NOT NULL,
	`trainee_id` text,
	`status` text DEFAULT 'PRECHECK_PENDING' NOT NULL,
	`status_detail` text,
	`last_match_score` real,
	`last_seen_at` integer,
	`precheck_at` integer,
	`precheck_attempts` integer DEFAULT 0 NOT NULL,
	`zoom_participant_uuid` text,
	`zoom_participant_user_id` text,
	`zoom_user_id` text,
	`zoom_display_name` text,
	`zoom_email` text,
	`zoom_joined_at` integer,
	`zoom_left_at` integer,
	`match_method` text,
	`match_confidence` real,
	`device_token_hash` text,
	`device_token_expires_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `session_participants_org_session_idx` ON `session_participants` (`organization_id`,`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_participants_session_trainee_uq` ON `session_participants` (`session_id`,`trainee_id`);--> statement-breakpoint
CREATE INDEX `session_participants_zoom_uuid_idx` ON `session_participants` (`session_id`,`zoom_participant_uuid`);--> statement-breakpoint
CREATE INDEX `session_participants_status_idx` ON `session_participants` (`organization_id`,`status`);--> statement-breakpoint
CREATE TABLE `trainees` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`department` text,
	`email` text,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trainees_org_external_uq` ON `trainees` (`organization_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `trainees_org_idx` ON `trainees` (`organization_id`);--> statement-breakpoint
CREATE INDEX `trainees_org_email_idx` ON `trainees` (`organization_id`,`email`);--> statement-breakpoint
CREATE INDEX `trainees_org_name_idx` ON `trainees` (`organization_id`,`name`);--> statement-breakpoint
CREATE TABLE `training_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`status` text DEFAULT 'SCHEDULED' NOT NULL,
	`zoom_meeting_id` text,
	`rule_version` text,
	`rule_snapshot` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`created_by` text,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `training_sessions_org_idx` ON `training_sessions` (`organization_id`);--> statement-breakpoint
CREATE INDEX `training_sessions_org_status_idx` ON `training_sessions` (`organization_id`,`status`);--> statement-breakpoint
CREATE INDEX `training_sessions_org_start_idx` ON `training_sessions` (`organization_id`,`starts_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`role` text DEFAULT 'training_admin' NOT NULL,
	`password_hash` text,
	`sso_subject` text,
	`last_login_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_org_email_uq` ON `users` (`organization_id`,`email`);--> statement-breakpoint
CREATE INDEX `users_org_idx` ON `users` (`organization_id`);--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`organization_id` text,
	`event_type` text NOT NULL,
	`payload_hash` text NOT NULL,
	`received_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`processed_at` integer,
	`result` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_deliveries_hash_uq` ON `webhook_deliveries` (`provider`,`payload_hash`);--> statement-breakpoint
CREATE TABLE `zoom_meetings` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`meeting_id` text NOT NULL,
	`meeting_uuid` text,
	`topic` text,
	`host_id` text,
	`join_url` text,
	`start_time` integer,
	`duration` integer,
	`status` text DEFAULT 'waiting' NOT NULL,
	`last_synced_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `zoom_meetings_org_meeting_uq` ON `zoom_meetings` (`organization_id`,`meeting_id`);--> statement-breakpoint
CREATE INDEX `zoom_meetings_uuid_idx` ON `zoom_meetings` (`meeting_uuid`);