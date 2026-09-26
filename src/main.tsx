import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./lib/auth-context";
import { forwardZoomOAuthReturn } from "./lib/zoom-oauth-return";
import "./styles/globals.css";

// Before anything renders: Zoom can return an authorization to the app's Home
// URL rather than to the redirect URI, in which case the code arrives on
// whatever page the browser landed on. Hand it to the callback instead of
// painting a dashboard over it. See src/lib/zoom-oauth-return.ts.
if (!forwardZoomOAuthReturn()) {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </StrictMode>,
  );
}
