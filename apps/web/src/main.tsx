/**
 * The entry point. `tokens.css` is imported once, before any component stylesheet, because every
 * component reads its custom properties (apps/web/UI_GUIDE.md section 1).
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./styles/fonts.css";
import "./styles/base.css";
import { App } from "./app/App";
import { BetaNotice } from "./dialogs/BetaNotice";
import { initBetaNotice } from "./dialogs/betaNoticeState";
import { appVersion } from "./report/setup";

const host = document.getElementById("root");
if (host === null) throw new Error("No #root element in index.html.");
// Decided before the first render, so the beta notice is in the first frame and the first run's
// card and tour, which wait for it, never start under it.
initBetaNotice(appVersion());
createRoot(host).render(
  <StrictMode>
    <App />
    {/* After the app, so its dialog opens over anything the app's first frame shows. */}
    <BetaNotice />
  </StrictMode>,
);
