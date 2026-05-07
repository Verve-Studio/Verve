import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { preferencesStore } from "./core/store/preferencesStore";
import "./styles/global.scss";

// Hydrate user preferences from disk before mounting React so the first
// render sees the persisted values (e.g. history memory cap is respected
// from frame zero, not from when an effect later catches up).
void preferencesStore.load().finally(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
