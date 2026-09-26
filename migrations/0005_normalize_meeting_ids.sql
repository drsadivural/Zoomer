-- Canonicalise stored Zoom meeting ids to digits only.
--
-- Zoom displays a meeting id as "801 755 4335" and administrators paste it
-- that way, but every webhook payload and API response carries "8017554335".
-- A session linked by hand therefore never matched an incoming event: its
-- participants never arrived, and the webhook would have created a second,
-- empty session beside it.
--
-- Data-only. No table, column or index is altered or dropped, and rows that
-- are already digits are left byte-identical.

UPDATE training_sessions
SET zoom_meeting_id = replace(replace(replace(replace(
      zoom_meeting_id, ' ', ''), '-', ''), CHAR(12288), ''), CHAR(9), '')
WHERE zoom_meeting_id IS NOT NULL
  AND zoom_meeting_id <> replace(replace(replace(replace(
      zoom_meeting_id, ' ', ''), '-', ''), CHAR(12288), ''), CHAR(9), '');

UPDATE zoom_meetings
SET meeting_id = replace(replace(replace(replace(
      meeting_id, ' ', ''), '-', ''), CHAR(12288), ''), CHAR(9), '')
WHERE meeting_id <> replace(replace(replace(replace(
      meeting_id, ' ', ''), '-', ''), CHAR(12288), ''), CHAR(9), '');
