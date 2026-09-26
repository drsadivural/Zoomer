/**
 * Completes a Zoom authorization that came back to the wrong URL.
 *
 * Zoom does not always send the browser to the redirect URI. For a General App
 * that also declares a Zoom App surface, authorization can land on the app's
 * **Home URL** instead, with `code` and `state` appended. That is what happens
 * here: the organizer signs in at Zoom, the browser arrives at
 * `https://zoomer.ayonix.com/?code=…&state=…`, the dashboard renders, and the
 * connection is never made — the callback that would exchange the code is
 * never reached. Nothing errors, so it reads as the feature silently not
 * working.
 *
 * Rather than depend on Marketplace configuration being exactly right, the app
 * forwards any authorization it finds on any page to its own callback. The
 * callback is unchanged and remains the only place that validates the state
 * signature and exchanges the code; this just gets the parameters to it.
 *
 * The Worker cannot do this itself: `/` is answered by Cloudflare's static
 * asset layer before the Worker runs, which is also what serves the security
 * headers Zoom's OWASP check requires. Routing the root through the Worker to
 * catch this would put those headers at risk for every page load.
 */

/** Where the callback lives. Must match `ZOOM_OAUTH_REDIRECT_PATH`. */
export const ZOOM_CALLBACK_PATH = "/api/v1/integrations/zoom/oauth/callback";

interface ZoomState {
  o: string;
  u: string;
  t: number;
  s: string;
}

/**
 * True when `state` is one of ours.
 *
 * Checked before forwarding so that an unrelated `?code=` on some future page
 * cannot be used to drive the OAuth callback. This is a shape check, not a
 * security check — the signature is verified server-side, where the key is —
 * but it keeps the redirect from firing on parameters that were never ours.
 */
export function looksLikeZoomState(state: string): boolean {
  try {
    const parsed = JSON.parse(atob(state)) as Partial<ZoomState>;
    return (
      typeof parsed.o === "string" &&
      typeof parsed.u === "string" &&
      typeof parsed.t === "number" &&
      typeof parsed.s === "string"
    );
  } catch {
    return false;
  }
}

/**
 * The URL to forward to, or null to render the page normally.
 *
 * Pure so the routing rules can be tested without a browser.
 */
export function zoomReturnTarget(pathname: string, search: string): string | null {
  // The callback itself, and anything else under the API, is server-side.
  if (pathname.startsWith("/api/")) return null;

  const params = new URLSearchParams(search);
  const code = params.get("code");
  const state = params.get("state");
  const error = params.get("error");

  // Zoom can also report a refusal to the Home URL. Forwarding it means the
  // organizer sees why, instead of a dashboard that looks like nothing
  // happened.
  if (error && state && looksLikeZoomState(state)) {
    return `${ZOOM_CALLBACK_PATH}${search}`;
  }

  if (!code || !state) return null;
  if (!looksLikeZoomState(state)) return null;

  return `${ZOOM_CALLBACK_PATH}${search}`;
}

/**
 * Runs before React mounts, so the dashboard never paints on the way past.
 * Returns true when a redirect was started and rendering should be skipped.
 */
export function forwardZoomOAuthReturn(location: Location = window.location): boolean {
  const target = zoomReturnTarget(location.pathname, location.search);
  if (!target) return false;
  // replace(), not assign(): the authorization code is single-use, so leaving
  // it in history invites a back-button retry that can only ever fail.
  location.replace(target);
  return true;
}
