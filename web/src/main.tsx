import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AgentboardViewer } from "./AgentboardViewer";
import { getTaskboardMetadata } from "./api";
import { initializeTaskboardStorage } from "./storage";
import "./styles.css";

async function main() {
  const mode = await getTaskboardMetadata().then((metadata) => metadata.mode, () => undefined);
  if (mode === "agentboard") document.title = "TaskDock";
  else await initializeTaskboardStorage();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      {mode === "agentboard" ? <AgentboardViewer /> : <App />}
    </StrictMode>,
  );
}

void main();
