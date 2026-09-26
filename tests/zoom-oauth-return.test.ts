/**
 * Zoom does not reliably send an authorization to the redirect URI. For a
 * General App with a Zoom App surface it can land on the app's Home URL
 * instead, with `code` and `state` appended — which is exactly what was
 * happening: the organizer signed in, arrived back at the dashboard, and the
 * connection was never made, with nothing anywhere reporting a failure.
 *
 * These pin the forwarding rules: anything that looks like one of our
 * authorizations is handed to the callback, and nothing else is.
 */
import { describe, expect, it } from "vitest";
import {
  looksLikeZoomState,
  ZOOM_CALLBACK_PATH,
  zoomReturnTarget,
} from "../src/lib/zoom-oauth-return";

/** A state of the shape `GET /authorize` issues. */
function state(over: Record<string, unknown> = {}): string {
  return btoa(
    JSON.stringify({
      o: "org_0AYNXZMERDEFA0000000000000",
      u: "usr_0AYNXZMERADMN0000000000000",
      t: Date.now(),
      s: "lXUzjeTEj+YStI2nEaNprsbay6X5lt34NSGAltuYuBI=",
      ...over,
    }),
  );
}

describe("looksLikeZoomState", () => {
  it("accepts a state of the shape we issue", () => {
    expect(looksLikeZoomState(state())).toBe(true);
  });

  it("rejects anything else", () => {
    expect(looksLikeZoomState("not-base64-json")).toBe(false);
    expect(looksLikeZoomState(btoa(JSON.stringify({ hello: "world" })))).toBe(false);
    // Missing the signature field.
    expect(looksLikeZoomState(btoa(JSON.stringify({ o: "a", u: "b", t: 1 })))).toBe(false);
    expect(looksLikeZoomState("")).toBe(false);
  });
});

describe("zoomReturnTarget", () => {
  it("forwards an authorization that landed on the Home URL", () => {
    const search = `?code=abc123&state=${state()}`;
    expect(zoomReturnTarget("/", search)).toBe(`${ZOOM_CALLBACK_PATH}${search}`);
  });

  it("forwards one that landed on any other page", () => {
    const search = `?code=abc123&state=${state()}`;
    expect(zoomReturnTarget("/settings", search)).toBe(`${ZOOM_CALLBACK_PATH}${search}`);
    expect(zoomReturnTarget("/live", search)).toBe(`${ZOOM_CALLBACK_PATH}${search}`);
  });

  it("forwards a refusal too, so the reason is shown rather than swallowed", () => {
    const search = `?error=access_denied&error_description=denied&state=${state()}`;
    expect(zoomReturnTarget("/", search)).toBe(`${ZOOM_CALLBACK_PATH}${search}`);
  });

  it("never forwards from under /api, which the server already owns", () => {
    // Without this the callback would forward to itself forever.
    const search = `?code=abc123&state=${state()}`;
    expect(zoomReturnTarget(ZOOM_CALLBACK_PATH, search)).toBeNull();
    expect(zoomReturnTarget("/api/v1/anything", search)).toBeNull();
  });

  it("ignores an ordinary page load", () => {
    expect(zoomReturnTarget("/", "")).toBeNull();
    expect(zoomReturnTarget("/enroll", "?q=sato")).toBeNull();
    expect(zoomReturnTarget("/live", "?session=ses_123")).toBeNull();
  });

  it("ignores a code with no state, and a state with no code", () => {
    expect(zoomReturnTarget("/", "?code=abc123")).toBeNull();
    expect(zoomReturnTarget("/", `?state=${state()}`)).toBeNull();
  });

  it("ignores a ?code= that is not ours", () => {
    // Some other feature's `code` parameter must not be able to drive the
    // OAuth callback just by being present.
    expect(zoomReturnTarget("/join/abc", "?code=1234&state=whatever")).toBeNull();
    expect(zoomReturnTarget("/", "?code=1234&state=" + btoa('{"x":1}'))).toBeNull();
  });

  it("does not re-fire on the page the callback redirects to", () => {
    // The callback sends the browser to /settings?zoom=… — no code, no state,
    // so there is no loop.
    expect(zoomReturnTarget("/settings", "?zoom=connected")).toBeNull();
    expect(zoomReturnTarget("/settings", "?zoom=error&stage=token&reason=bad")).toBeNull();
  });
});
