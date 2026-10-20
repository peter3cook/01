import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HttpApi, type CopilotApi } from "./api/client";
import { App } from "./App";
import { ConfirmProvider } from "./components/confirm";
import "./styles.css";

async function boot() {
  let api: CopilotApi;
  if (__STANDALONE__) {
    // Preview build only: the engine runs in the browser with simulated data.
    const { LocalApi } = await import("./api/localApi");
    api = new LocalApi();
  } else {
    api = new HttpApi();
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ConfirmProvider>
        <App api={api} />
      </ConfirmProvider>
    </StrictMode>,
  );
}

void boot();
