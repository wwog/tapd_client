<div align="center">

<img src="apps/desktop/src-tauri/icons/icon.png" width="96" alt="TAPD Client" />

# TAPD Client

**你的工作从未如此轻松。**

缺陷、需求、通知、一键 AI 修复。<br />


<p>
  <a href="https://github.com/wwog/tapd_client/releases/latest">
    <img src="https://img.shields.io/badge/%E4%B8%8B%E8%BD%BD-macOS%20arm64-0A84FF?style=for-the-badge&logo=apple&logoColor=white" alt="下载 macOS arm64 版" />
  </a>
  <a href="docs/MCP.md">
    <img src="https://img.shields.io/badge/MCP-16%20tools-34C759?style=for-the-badge" alt="MCP 16 tools" />
  </a>
  <a href="CHANGELOG.md">
    <img src="https://img.shields.io/github/v/release/wwog/tapd_client?style=for-the-badge&label=version&color=1F2937" alt="版本" />
  </a>
</p>

<img src="snaps/login_page.png" width="100%" alt="TAPD Client 登录页：企业微信扫码" />

<sub>扫码登录 · 登录态只留在本机</sub>

</div>



## 使用

1. **下载** [最新 macOS arm64 版](https://github.com/wwog/tapd_client/releases/latest)，拖进「应用程序」。
2. **扫码** 用企业微信扫一下，登录态留在本机。
3. **开工** 选项目、看缺陷、把该修的丢进 AI 队列。

> 首次打开若被 macOS 拦下，到「系统设置 → 隐私与安全性」允许一次即可。

## 深入了解

| 文档 | 内容 |
| --- | --- |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | 系统结构、模块地图、关键链路与设计取舍 |
| [UI_STYLE.md](docs/UI_STYLE.md) | 边框、色彩、字重、文案与主题的硬性规范 |
| [DEVELOPMENT.md](docs/DEVELOPMENT.md) | 开发命令、首次运行、本地数据位置 |
| [MCP.md](docs/MCP.md) | 16 个工具、目录匹配项目、修复提示词、外部占用、AI 通知格式、Agent 审核、客户端接入、策略与审计 |
| [NOTIFICATIONS.md](docs/NOTIFICATIONS.md) | 通知范围、轮询、去重与 AI 卡片 |
| [AGENT.md](docs/AGENT.md) | 修复队列、审核与任务状态 |
| [RELEASE.md](docs/RELEASE.md) | 打包、签名与发版 |
| [PLAN.md](docs/PLAN.md) | 阶段计划与验收记录 |
| [spike.md](docs/spike.md) | TAPD 内部接口验证 |

## 参与开发

```bash
pnpm install
pnpm dev
```

更多命令与 CI 说明见 [DEVELOPMENT.md](docs/DEVELOPMENT.md)。

<div align="center">
<br />

### 你的工作从未如此轻松

[下载 TAPD Client](https://github.com/wwog/tapd_client/releases/latest)

macOS 11+ · Apple Silicon · 自动更新

</div>
