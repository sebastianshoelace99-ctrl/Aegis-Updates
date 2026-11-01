import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppProviders } from "./app/providers";
import { AuthGate } from "./features/auth/AuthGate";
import "./theme/index.css";
import "./styles/tokens.css";
import "./styles/global.css";

/*
 * The saved theme, mode and density are applied by `public/theme-boot.js`, a blocking script in
 * `<head>`: doing it here would be one painted frame too late. This module's only job is to mount.
 */

const container = document.getElementById("root");
if (!container) throw new Error("#root is missing from index.html");

createRoot(container).render(
  <StrictMode>
    <AppProviders>
      <AuthGate />
    </AppProviders>
  </StrictMode>,
);

