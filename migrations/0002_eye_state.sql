ALTER TABLE `meeting_monitoring_settings` ADD `drowsiness_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `meeting_monitoring_settings` ADD `eyes_closed_sec` integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE `participant_analysis_state` ADD `eye_closed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `participant_analysis_state` ADD `eye_openness` real;--> statement-breakpoint
ALTER TABLE `participant_analysis_state` ADD `eyes_closed_since` integer;--> statement-breakpoint
ALTER TABLE `participant_observations` ADD `eye_closed` integer;--> statement-breakpoint
ALTER TABLE `participant_observations` ADD `eye_openness` real;