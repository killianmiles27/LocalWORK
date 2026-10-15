import { Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// A render error must never leave a blank window: show it and offer a reload.
class Boundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div className="h-full grid place-items-center p-8">
        <div className="max-w-xl">
          <h1 className="text-lg font-semibold mb-2">Something went wrong in the interface</h1>
          <pre className="text-xs whitespace-pre-wrap bg-panel border border-line rounded-lg p-3 mb-3">{String(this.state.err.stack ?? this.state.err)}</pre>
          <button className="rounded-lg bg-accent text-white px-4 py-2" onClick={() => location.reload()}>Reload</button>
        </div>
      </div>
    );
  }
}

createRoot(document.getElementById("root")!).render(<Boundary><App /></Boundary>);
