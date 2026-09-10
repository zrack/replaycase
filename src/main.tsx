import React from "react";
import { createRoot } from "react-dom/client";
import { config as configureZod } from "zod";
import { loadOperatorRuntime } from "./runtime/operator-runtime";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "./styles.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("ReplayCase could not find its root element.");
}

configureZod({ jitless: true });

void Promise.all([
  import("./App"),
  loadOperatorRuntime(),
]).then(([{ App }, operatorRuntime]) => {
  createRoot(rootElement).render(
    <React.StrictMode>
      <App operatorRuntime={operatorRuntime} />
    </React.StrictMode>,
  );
});
