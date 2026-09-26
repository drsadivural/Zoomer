-- Blink rate and image sharpness.
--
-- The organizer console names nine per-participant signals. Seven were already
-- measured; 瞬き (blink) and 鮮明度 (sharpness) were not stored anywhere, so the
-- console had nothing to show for them.
--
-- Blink is deliberately a *rate reported by the capture side*, not something
-- derived here. A blink lasts 100-400ms; observations arrive every 2-10s, so
-- counting closed->open transitions across observations would undercount by an
-- order of magnitude and produce a confident wrong number. Null means "not
-- measured", which the UI renders as 未測定 rather than as zero.
--
-- Additive only: every column is nullable or has a default, so a worker running
-- the previous code is unaffected by this migration.

alter table participant_analysis_state add column blink_rate_per_min real;
alter table participant_analysis_state add column blink_count integer not null default 0;
alter table participant_analysis_state add column sharpness real;

alter table participant_observations add column blink_rate_per_min real;
alter table participant_observations add column sharpness real;
