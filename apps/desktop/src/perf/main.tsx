import ReactDOM from "react-dom/client";

import { AgentHostProvider } from "../../../shared/agent/host";
import { TurnBlock } from "../../../shared/agent/TurnBlock";
import { PromptNavigator } from "../agent/PromptNavigator";
import { Markdown } from "../components/Markdown";
import "../styles.css";
import { buildFixture } from "./fixture";

const block = buildFixture();
const demoPrompts = [
  {
    key: "turn:3",
    seq: 3,
    text: "查了一下，卡顿不是帧率掉，是展开时浏览器的 scroll anchoring 在改 scrollTop；先把动画和布局拆开量。",
    added: 4,
    removed: 0,
  },
  {
    key: "turn:2",
    seq: 2,
    text: "先复现一下，量一下是哪种展开在掉帧，再决定是换动画实现还是对大块内容降级。",
    added: 4,
    removed: 0,
  },
  {
    key: "turn:1",
    seq: 1,
    text: "展开有点卡顿。",
    added: 11,
    removed: 0,
  },
];

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
      {/* Wide copy for the prompt navigator preview (its trigger is a
          container-query element; the 900px transcript is below the breakpoint). */}
      <div className="@container relative mt-4 h-64 w-[1100px] border border-border bg-canvas">
        <PromptNavigator
          items={demoPrompts}
          currentKey="turn:3"
          onJump={() => undefined}
        />
      </div>
    </AgentHostProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
