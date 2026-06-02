import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { LanguageProvider } from "./hooks/useLanguage";
import { FontSizeProvider } from "./hooks/useFontSize";
import { WriteModeProvider } from "./hooks/useWriteMode";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LanguageProvider>
      <FontSizeProvider>
        <WriteModeProvider>
          <App />
        </WriteModeProvider>
      </FontSizeProvider>
    </LanguageProvider>
  </React.StrictMode>,
);
