import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

const root = document.getElementById("root") as HTMLElement;

window.addEventListener("error", (event) => {
  renderFatalError(event.error instanceof Error ? event.error.message : event.message);
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  renderFatalError(reason instanceof Error ? reason.message : String(reason));
});

try {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
} catch (error) {
  renderFatalError(error instanceof Error ? error.message : String(error));
}

function renderFatalError(message: string): void {
  if (root.childElementCount > 0) {
    return;
  }

  root.innerHTML = `
    <main class="fatal-shell">
      <section class="fatal-panel">
        <h1>Single Channel E2EE IRC</h1>
        <p>前端启动失败。请把下面的错误发给维护者：</p>
        <pre></pre>
      </section>
    </main>
  `;
  root.querySelector("pre")!.textContent = message;
}
