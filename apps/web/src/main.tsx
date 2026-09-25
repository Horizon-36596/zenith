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

const host = document.getElementById("root");
if (host === null) throw new Error("No #root element in index.html.");
createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
