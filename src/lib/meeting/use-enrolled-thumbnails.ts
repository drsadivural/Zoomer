/**
 * Enrolment thumbnails for participants with no live frame.
 *
 * A tile with nothing but initials tells an organizer nothing about who they
 * are looking at. When the participant is matched to a trainee and the
 * organization has opted into storing enrolment thumbnails, the enrolled face
 * is a better placeholder than two characters of their name.
 *
 * Fetched in one batch for the whole grid rather than per card: the endpoint
 * is permission-checked and audit-logged, and 200 cards each firing their own
 * request would be 200 audit entries for one screen.
 *
 * This is strictly a fallback. A live analysed frame always wins, because the
 * enrolled photo shows who *should* be there, not who is.
 */
import { useEffect, useState } from "react";
import { api, type MeetingParticipant } from "@/lib/api";

export function useEnrolledThumbnails(
  participants: MeetingParticipant[],
  enabled: boolean,
): Record<string, string> {
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});

  // Only participants who need one: matched to a trainee, and with no live
  // frame of their own. Sorted and joined so the effect re-runs when the set
  // changes rather than on every poll returning a new array identity.
  const wanted = Array.from(
    new Set(
      participants
        .filter((p) => p.traineeId && !p.thumbnailEvidenceId)
        .map((p) => p.traineeId as string),
    ),
  ).sort();
  const key = wanted.join(",");

  useEffect(() => {
    if (!enabled || !key) return;
    const ids = key.split(",");
    // Already have every one of them: a poll that adds no new people must not
    // re-request the whole roster.
    const missing = ids.filter((id) => !(id in thumbnails));
    if (!missing.length) return;

    let cancelled = false;
    api
      .traineeThumbnails(missing)
      .then((r) => {
        if (cancelled || !r.enabled) return;
        setThumbnails((prev) => ({ ...prev, ...r.thumbnails }));
      })
      // Thumbnails are opt-in and permission-gated. A reader without
      // evidence:view, or an organization that never enabled them, simply gets
      // initials — not an error banner on a monitoring screen.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // `thumbnails` is deliberately not a dependency: it is read only to skip
    // ids already fetched, and including it would re-run the effect on every
    // successful fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  return thumbnails;
}
