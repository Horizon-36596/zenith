/** Entry point for the dev-only canvas page. Not part of the editor bundle. */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import CanvasHarness from "./CanvasHarness.js";

const host = document.getElementById("root");
if (host === null) throw new Error("No #root element in canvas-dev.html.");
createRoot(host).render(
  <StrictMode>
    <CanvasHarness />
  </StrictMode>,
);
