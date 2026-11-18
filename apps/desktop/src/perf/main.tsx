import ReactDOM from "react-dom/client";

import { AgentHostProvider } from "../../../shared/agent/host";
import { TurnBlock } from "../../../shared/agent/TurnBlock";
import { Markdown } from "../components/Markdown";
import "../styles.css";
import { buildFixture } from "./fixture";

const block = buildFixture();

function App() {
  return (
    <AgentHostProvider value={{ renderMarkdown: (source) => <Markdown source={source} /> }}>
      <div
        id="perf-scroll"
        data-perf-scroll
        className="h-[760px] w-[900px] overflow-y-auto overscroll-contain border border-border bg-canvas"
        style={{ overflowAnchor: "none" }}
      >
        <div className="agent-type flex flex-col gap-5 p-4">
          <TurnBlock block={block} running={false} locale="zh" />
        </div>
      </div>
    </AgentHostProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
