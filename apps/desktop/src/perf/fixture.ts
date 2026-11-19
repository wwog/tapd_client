import type { AgentEntry, AgentTurnBlock } from "../../../shared/agent/types";

const T0 = Date.parse("2026-11-18T03:34:00.000Z");

function at(seconds: number): string {
  return new Date(T0 + seconds * 1000).toISOString();
}

function section(index: number): string {
  const rows = Array.from(
    { length: 10 },
    (_, row) =>
      `| ${row + 1} | 指标 ${index}.${row + 1} | ${(1234.56 + index * 10 + row).toFixed(2)} | +${(row + 1.2).toFixed(1)}% |`,
  ).join("\n");
  return [
    `## ${index}. 第 ${index} 节标题`,
    "",
    `正文段落用于压力测试：这一段包含中英文混排、数字与标点（如 12.5%、¥1,234.56、AI/ML、H₂O），以及一个刻意拉长的句子，用来观察长文本在宽度变化与折叠展开时的排版稳定性。`,
    "",
    "| 序号 | 指标 | 数值 | 同比 |",
    "| ---: | :--- | ---: | ---: |",
    rows,
    "",
    "- 列表项 A：确认数据口径与时间戳",
    "- 列表项 B：交叉验证至少两个独立信源",
    "- 列表项 C：区分「已发生事实」与「市场预期」",
    "",
    "```python",
    "def top_movers(quotes, n=5):",
    '    """按涨跌幅绝对值排序，返回前 n 个标的。"""',
    "    return sorted(quotes, key=lambda q: abs(q.pct), reverse=True)[:n]",
    "```",
    "",
    "> 引用：信息应标注来源与时间戳，避免无出处结论被二次传播放大。",
    "",
  ].join("\n");
}

function longAnswer(): string {
  const sections = Array.from({ length: 9 }, (_, index) => section(index + 1));
  return [
    "已抓取完毕（数据截至 11月18日 11:37，A股为午间收盘数据）。以下是今日资讯要点。",
    "",
    ...sections,
    "## 结尾",
    "",
    "如果这份长输出能完整渲染到这里，说明长文本通道基本通畅。测试状态：长输出已生成完毕。",
  ].join("\n");
}

function tool(
  seq: number,
  seconds: number,
  description: string,
  command: string,
  status: "ok" | "error" = "ok",
): AgentEntry {
  return {
    kind: "tool",
    seq,
    at: at(seconds),
    turn: 1,
    step: 1,
    callId: `call-${seq}`,
    name: "bash",
    args: JSON.stringify({ description, command }),
    status,
    result: status === "ok" ? "200 OK" : "exit 1",
    startedAtMs: T0 + seconds * 1000,
    endedAtMs: T0 + seconds * 1000 + 1200,
  };
}

export function buildFixture(): AgentTurnBlock {
  const entries: AgentEntry[] = [];
  let seq = 1;
  const push = (entry: AgentEntry) => {
    entries.push(entry);
    seq += 1;
  };
  const reasoning = (seconds: number, text: string) => {
    push({
      kind: "assistant",
      seq,
      at: at(seconds),
      turn: 1,
      step: 1,
      text: "",
      reasoning: text,
      startedAtMs: T0 + seconds * 1000,
      completedAtMs: T0 + seconds * 1000 + 11_000,
    });
  };
  const note = (seconds: number, text: string) => {
    push({
      kind: "assistant",
      seq,
      at: at(seconds),
      turn: 1,
      step: 1,
      text,
      completedAtMs: T0 + seconds * 1000,
    });
  };

  // The committed block starts with the prompt; the turn markers are external.
  push({ kind: "user", seq, at: at(0), turn: 1, step: 0, text: "整理一下今天的股市资讯" });

  reasoning(2, "先确认网络可用性，再并行抓取指数与新闻源。");
  push(tool(seq, 6, "检查财经站点连通性", 'curl -sS -m 15 -o /dev/null -w "%{http_code}" https://www.eastmoney.com/'));
  reasoning(9, "行情接口正常，开始抓指数快照。");
  push(tool(seq, 13, "抓取上证指数", "curl -sS 'https://push2.eastmoney.com/api/qt/stock/get?secid=1.000001'"));
  push(tool(seq, 14, "抓取深证成指", "curl -sS 'https://push2.eastmoney.com/api/qt/stock/get?secid=0.399001'"));
  push(tool(seq, 15, "抓取创业板指", "curl -sS 'https://push2.eastmoney.com/api/qt/stock/get?secid=0.399006'"));
  note(20, "Good — live quotes are working. Now let me pull the news feeds.");

  for (let index = 0; index < 10; index += 1) {
    push(
      tool(
        seq,
        24 + index * 3,
        index % 3 === 0 ? "抓取财经快讯" : index % 3 === 1 ? "抓取板块行情" : "交叉校验数字",
        `curl -sS 'https://example.com/feed?page=${index + 1}'`,
        index === 7 ? "error" : "ok",
      ),
    );
    if (index === 4) {
      reasoning(39, "新闻源返回结构发生变化，切换到备用字段解析。");
    }
  }

  note(58, longAnswer());

  return {
    key: "turn:1",
    start: { seq: 0, at: at(0), turn: 1 },
    end: { seq: seq + 1, at: at(200), turn: 1, reason: "completed" },
    entries,
  };
}
