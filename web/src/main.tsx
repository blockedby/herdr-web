import "@fontsource-variable/geist/wght.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { BridgeProvider } from "./bridge";
import { startNativeControls } from "./native";
import "./styles.css";
import "./telegram.css";
import { TelegramGate } from "./TelegramGate";

startNativeControls();

const root = document.getElementById("root");

if (!root) {
  throw new Error("missing root element");
}

createRoot(root).render(
  <StrictMode>
    <TelegramGate>
      <BridgeProvider>
        <App />
      </BridgeProvider>
    </TelegramGate>
  </StrictMode>,
);
