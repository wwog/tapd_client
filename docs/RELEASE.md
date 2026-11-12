# 打包与发版

发布物是 macOS **arm64**（Apple Silicon）dmg，其中 `tapd-mcp` sidecar 会被打进 `TAPD Client.app/Contents/MacOS/tapd-mcp`，用户无需单独安装 MCP 二进制。不再产出 universal / x86_64 包。

客户端通过 Tauri updater 从 GitHub Releases 自动更新：发布 release 时额外产出签名过的 `*.app.tar.gz` 与 `latest.json`，App 启动后检查一次、之后每 30 分钟检查一次。

## 1. 一键发版（推荐）

前提：工作区干净、当前在 `main`、本机已经能推送到 `origin`。

```bash
scripts/release.sh 1.0.0
```

脚本会依次：

1. 把 `package.json`、`apps/desktop/package.json`、`apps/desktop/src-tauri/tauri.conf.json` 和 `Cargo.toml` 的 workspace 版本改为 `1.0.0`，并刷新 `Cargo.lock`；
2. 从上一个 `v*` tag 到 `HEAD` 的提交生成 `docs/releases/v1.0.0.md`，同时插入 `CHANGELOG.md`；
3. 在 `main` 上提交 `chore(release): v1.0.0`；
4. `git push origin main`，把 `main` 合并进 `release` 并推送；
5. 打 `v1.0.0` tag 并推送，触发 GitHub Actions 发布 dmg + 更新包 + `latest.json`。

只想在本地准备提交、不推送：

```bash
scripts/release.sh 1.0.0 --no-push
```

> `release` 分支只接受来自 `main` 的合并。`.github/workflows/release-guard.yml` 会拒绝其他来源的 PR。

### 更新日志怎么写

版本说明手写在 `CHANGELOG.md` 顶部的 `## 未发布` 里，固定按 `### 新增` / `### 修改` / `### 修复` 三节，只写用户能感知的变化：

- **新增**：新功能、新工具、新入口。
- **修改**：已有行为、数据存储、交互方式的调整。
- **修复**：缺陷修复，写清楚修的是什么问题。

发版时 `scripts/changelog.mjs` 会把这段原样搬进 `docs/releases/v<version>.md`（标题层级从 `###` 升为 `##`）并插入 `CHANGELOG.md`；只有 `## 未发布` 缺失或为空时，才回退到按 commit 前缀自动生成。

### 强制更新

需要用户必须升级时，在 `CHANGELOG.md` 的 `## 未发布` 第一行（或 `docs/releases/v<version>.md` 顶部）加一行：

```markdown
<!-- force-update -->
```

- 该行是 HTML 注释，GitHub Release 页面不显示；客户端会从展示的更新日志里去掉它。
- `latest.json` 的 `notes` 携带该标记，客户端识别后要求升级：登录页与主界面都会弹出不可关闭的模态框，只能「立即升级」或退出应用；升级失败可重试或手动下载。
- 需求同时写入 `config.json` 的 `forcedUpdate`（版本 + 记录时间），重启或离线也会继续提示，直到当前版本不低于该版本。
- 升级检查在启动时立即执行（登录页也能收到），之后每 30 分钟一次。
- 不要给不打算强制升级的版本加这个标记；标记发布后无法通过撤回版本绕过。

## 2. 分支流程（手动）

- **日常开发在 `main`**：从 `main` 拉分支/提交 PR，CI 通过后合并回 `main`。
- **`release` 只接受来自 `main` 的合并**：

```bash
git checkout main
git pull
git checkout release
git merge --ff-only main
git push origin release
```

推送 `release` 会触发 `release.yml`，产出 arm64 dmg artifact。确认无误后再打 tag：

```bash
git tag v1.0.0
git push origin v1.0.0
```

## 3. 自动更新的签名密钥（必须）

Tauri updater 用 minisign 校验更新包。公钥已经写在 `apps/desktop/src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`；私钥只放在本机与 GitHub Secrets 中。

已生成的密钥：

```text
私钥：~/.tauri/tapd_client.key
公钥：~/.tauri/tapd_client.key.pub（内容已提交到 tauri.conf.json）
```

仓库 Secrets 需要配置：

| Secret | 说明 |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | `~/.tauri/tapd_client.key` 的完整内容（无密码） |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 可选；当前密钥无密码，留空即可 |

设置方式：GitHub 仓库 → Settings → Secrets and variables → Actions → New repository secret，把私钥文件内容整段粘贴进去。

> 私钥丢失后无法再签发可被旧客户端接受的更新包，必须发布一个带新公钥的版本。不要把私钥提交到仓库。

## 4. CI 产物

| 触发 | 产物 |
| --- | --- |
| push `release` | arm64 dmg + `.app` artifact（不生成更新包） |
| push `v*` tag | dmg、`TAPD.Client_<version>_aarch64.app.tar.gz`、对应 `.sig`、`latest.json`、`SHA256SUMS.txt`，并创建 GitHub Release |

`latest.json` 的更新说明来自 `docs/releases/<tag>.md`（由 `scripts/changelog.mjs` 生成），平台键为 `darwin-aarch64`。客户端的检查地址是：

```text
https://github.com/wwog/tapd_client/releases/latest/download/latest.json
```

> `latest` 会跳过 draft 与 prerelease；发布时不要勾选 prerelease，否则客户端不会收到更新。

## 5. 本地打包

```bash
pnpm install
pnpm build        # 本机架构（Apple Silicon 即 arm64）：先构建 sidecar，再 tauri build
pnpm build:arm64  # 显式 arm64，与 CI 完全一致
```

本地普通打包不会生成更新包，因此不需要私钥。若要在本机生成签名更新包用于测试：

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/tapd_client.key)"
pnpm -C apps/desktop tauri build --target aarch64-apple-darwin --bundles app,dmg \
  --config '{"bundle":{"createUpdaterArtifacts":true}}'
```

产物：

```text
target/aarch64-apple-darwin/release/bundle/macos/TAPD Client.app
target/aarch64-apple-darwin/release/bundle/dmg/TAPD Client_<version>_<arch>.dmg
target/aarch64-apple-darwin/release/bundle/macos/TAPD Client.app.tar.gz(.sig)
```

`cargo check --workspace` / `cargo test --workspace` 也会触发 Tauri build script，而它要求 `binaries/` 下的 sidecar 存在；直接用 `pnpm check:rust` / `pnpm test:rust`（会自动先构建 debug sidecar），或先跑 `pnpm build:sidecar:debug`。

## 6. 更新流程测试（v0.1.0 → v1.0.0）

1. 在包含自动更新代码、但版本仍为 `0.1.0` 的提交上本地打包 v0.1.0：
   ```bash
   pnpm install
   pnpm build:arm64
   ```
   产物在 `target/aarch64-apple-darwin/release/bundle/`，把 `TAPD Client.app` 拖到 `/Applications` 或直接运行。
2. 发布 `v1.0.0`（见第 1 节），等 Actions 完成。
3. 打开 v0.1.0：标题栏右侧图标在发现 `1.0.0` 后变绿；hover 显示更新日志。
4. 进入账户页点「立即更新」（或点击标题栏绿色图标直达）：主窗口隐藏，顶部胶囊放大到 3 倍并依次显示「正在下载更新」「正在解包并安装」，完成后 App 自动重启为 1.0.0。
5. 失败场景：断网或替换错误的更新包会进入「更新失败」，胶囊提供「手动下载 / 取消」；取消后主窗口恢复，可再次点「立即更新」。

## 7. 签名与公证（可选）

默认产物未签名，用户首次打开需要到「系统设置 → 隐私与安全性」允许。配置以下 repository secrets 后，`release.yml` 会自动启用 Apple 签名（有 `APPLE_CERTIFICATE` 时）：

| Secret | 说明 |
| --- | --- |
| `APPLE_CERTIFICATE` | Developer ID Application 证书的 base64 |
| `APPLE_CERTIFICATE_PASSWORD` | 证书导出密码 |
| `APPLE_SIGNING_IDENTITY` | 例如 `Developer ID Application: Example (TEAMID)` |
| `APPLE_ID` | 公证用 Apple ID（可选） |
| `APPLE_PASSWORD` | App 专用密码（可选） |
| `APPLE_TEAM_ID` | Team ID（可选） |

启用签名后，建议对首次产物做一次校验：`codesign --verify --deep --strict "TAPD Client.app"`，并用 `codesign -dv "TAPD Client.app/Contents/MacOS/tapd-mcp"` 确认 sidecar 也在签名范围内（Tauri 打包时会一并签名 `externalBin`）。

## 8. 常见问题

- **CI 报缺少更新签名密钥**：tag 构建必须配置 `TAURI_SIGNING_PRIVATE_KEY`；`release` 分支构建不需要。
- **客户端一直提示同一版本**：确认 GitHub Release 不是 prerelease/draft，且 `latest.json` 已上传；`version` 必须大于客户端当前版本。
- **更新包签名校验失败**：CI 私钥与 `tauri.conf.json` 的公钥不匹配，或 `latest.json` 里的 `signature` 不是对应 `.sig` 的内容。
- **`"…/src-tauri/binaries/tapd-mcp-aarch64-apple-darwin" does not exist`**：还没构建 sidecar，运行 `pnpm build:sidecar` 或直接用 `pnpm build`。
- **CI 安装依赖失败**：确认 `pnpm-lock.yaml` 已随提交更新（`pnpm install` 后提交）。
