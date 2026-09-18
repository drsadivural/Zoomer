-- DESTRUCTIVE. Clears all tenant data. Intended for development and for
-- resetting a demo environment — never run against production with real data.
DELETE FROM webhook_deliveries;
DELETE FROM idempotency_keys;
DELETE FROM reports;
DELETE FROM audit_logs;
DELETE FROM alert_reviews;
DELETE FROM alerts;
DELETE FROM monitoring_events;
DELETE FROM evidence_objects;
DELETE FROM session_participants;
DELETE FROM training_sessions;
DELETE FROM zoom_meetings;
DELETE FROM consents;
DELETE FROM face_enrollments;
DELETE FROM trainees;
DELETE FROM notification_rules;
DELETE FROM integrations;
DELETE FROM monitoring_settings;
DELETE FROM auth_sessions;
DELETE FROM users;
DELETE FROM organizations;
