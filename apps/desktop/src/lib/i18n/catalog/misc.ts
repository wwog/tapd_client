/** misc catalogue: short semantic key -> [zh, en]. */
import type { Catalog } from "../types";

export const misc = {
  // Background services that boot with the app and stayed down after the
  // startup guard's automatic attempts.
  "service.failed.title": ["后台服务启动失败", "Background service failed to start"],
  "service.failed.agent": ["内置 Agent 运行时", "Agent runtime"],
  "service.failed.companion": ["伴侣服务", "Companion service"],
  "service.failed.attempts": ["已自动尝试 {attempts} 次", "Tried {attempts} times"],
  "service.failed.logs": ["查看日志", "View logs"],
  "service.failed.retry": ["重新启动", "Restart"],
  "service.failed.restartApp": ["重启应用", "Restart app"],
  "service.failed.later": ["稍后处理", "Later"],
  "service.failed.hint": [
    "失败详情已写入日志文件；重新启动只会再尝试一次。",
    "Details were written to the log file; restarting makes one more attempt.",
  ],
} as const satisfies Catalog;
