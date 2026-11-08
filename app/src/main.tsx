import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { restorePanelWidths } from "./components/ResizeHandle";
import "./styles/tokens.css";
import "katex/dist/katex.min.css";
import "./styles/app.css";
import "./styles/markdown.css";

restorePanelWidths();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
