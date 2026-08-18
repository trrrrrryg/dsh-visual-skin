# dsh-visual-skin

**DeepSeek Harness Skin Studio — 为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 打造的一键可视化换肤工具**

> A visual skin studio for DeepSeek Harness (DSH): design, preview and safely apply skins with one click — no config files to touch. Ship as an Agent Skill + MCP server + DSH plugin, with a one-shot PowerShell installer.

安装后，你的 AI 助手只需一张图片，就能自动完成 **图片上传 → 主题创作 → 隔离预览 → 人工确认应用** 的完整换肤流程；也可以打开独立的 Studio 网页可视化调整皮肤，一键写入 DSH。

---

## ✨ 功能

| 能力 | 说明 |
|---|---|
| 🎨 **Skin Studio（可视化设计器）** | 独立 Web UI：双区域背景（侧边栏/主区）、图片/渐变背景、玻璃拟态、token 调色、区域选择器，所见即所得 |
| 🤖 **Agent Skill** | 安装后 DSH / Codex 助手收到"换肤 / 用这张图做背景"请求时，自动编排完整换肤流程 |
| 🔌 **MCP Server（26 个工具）** | `doctor` / `design_create` / `asset_upload` / `theme_patch` / `theme_get` / `theme_validate` / `preview_start` / `theme_apply_plan` / `theme_apply` 等，注册为 `mcp__skin-studio__*` |
| 🖥️ **DSH 插件** | 常驻背景（body 级 CSS，切换对话不失效）、对话蒙版（点击即生效、切换无感）、侧边栏分隔线、余额栏（设置上方余额按钮 + 对话详情余额显示、可刷新） |
| 🛡️ **安全边界** | 所有"写入 DSH"操作都经过 **隔离 DSH 预览 → 不可变 apply 计划 → 人工在可见 UI 中确认**；MCP 永远无法伪造确认 |
| 📦 **一键安装** | PowerShell 安装器自动完成 构建 → 装 Skill → 注册插件 → 注册 MCP → 启动 Studio → （可选）同步 Codex |

---

## 📦 安装

### 前置要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Windows | 10 / 11 | 安装器为 PowerShell 脚本 |
| [Node.js](https://nodejs.org/) | 22+ | 插件与 Controller 运行必需 |
| [pnpm](https://pnpm.io/installation) | 11+ | 仅首次安装需要（用于构建便携运行时） |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | 0.1.0-rc.6 | 目标版本，能力钉扎，版本不符时插件 fail-closed |

### 方式一：命令行安装（推荐）

```powershell
# 1. 获取项目
git clone https://github.com/trrrrrryg/dsh-visual-skin.git
cd dsh-visual-skin

# 2. 一键安装（默认目标：%USERPROFILE%\.dsh，profile: web，Controller 端口 11862）
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

安装器自动完成：

1. 构建/复用自包含便携运行时（Controller + Studio + MCP + 插件，约 51MB，装到 Skill 目录下）；
2. 安装 Skill 到 `%DSH_HOME%\skills\deepseek-harness-skin-studio`（DSH 助手立即获得该技能）；
3. 注册 DSH 插件（`cordis.patch.yml` 托管块，含 `皮肤设置` 设置卡片）；
4. 注册 MCP 服务器（`mcp__skin-studio__*`，指向安装后的自包含运行时）；
5. 启动 Studio（Controller，默认端口 11862，浏览器访问 `http://127.0.0.1:11862`）；
6. 检测到 Codex 时自动同步 Skill 并注册 Codex MCP。

安装完成后**重启一次 DSH**（或在桌面启动器中重启），使 profile patch 与 MCP 客户端生效。

#### 可选参数

| 参数 | 说明 |
|---|---|
| `-DshHome <path>` | DSH 根目录（默认 `%USERPROFILE%\.dsh`） |
| `-ProfileName <name>` | 目标 profile（默认 `web`） |
| `-DataDir <path>` | Studio 数据目录（默认 `%LOCALAPPDATA%\DeepSeekHarnessSkinStudio`） |
| `-ControllerPort <port>` | Studio Controller 端口（默认 `11862`） |
| `-SkipBuild` | 使用已构建的 runtime，跳过构建 |
| `-SkipSkill` / `-SkipStudio` / `-SkipCodexMcp` | 跳过对应组件 |
| `-RestartDsh` | 安装后自动重启 DSH（默认不重启，避免打断正在运行的会话） |

示例（自定义安装 + 安装后自动重启 DSH）：

```powershell
.\install.ps1 -DshHome C:\Users\me\.dsh -ProfileName web -ControllerPort 12000 -RestartDsh
```

### 方式二：AI 安装

把本仓库交给任意 agent，并告诉它：

> 请阅读 README 与本仓库的 `install.ps1`，然后执行安装。

agent 会按上述流程完成安装（它也可以直接运行 `install.ps1`）。

### 验证安装

```powershell
# 插件健康检查（在 DSH 端口上，应返回 ok:true；默认 DSH 端口 10402）
Invoke-RestMethod http://127.0.0.1:10402/dsh-skin/health

# Controller / Studio 状态检查（应返回 ok:true、capabilities.compatible:true）
Invoke-RestMethod http://127.0.0.1:11862/api/v1/status
```

- Studio 打开：`http://127.0.0.1:11862`（或点开始菜单/托盘图标）
- DSH 设置页应出现「皮肤设置」卡片；向助手说"换个皮肤"即可触发 `mcp__skin-studio__*` 工具。

---

## 🚀 使用

安装并重启后，直接对 DSH 助手说：

- **"给我换个皮肤"** / **"用这张图片做背景"** → 助手自动调用 `mcp__skin-studio__*` 完成创作并在 Studio 中预览；
- **"把现在的皮肤背景换掉"** → 助手修改当前设计；
- 在 Studio 中手动调整（背景、区域、token、分隔线）→ 点 **写入我的 DSH**，在弹出的计划确认窗口中人工确认 → 重启 DSH 后生效。

### 换肤流程图

```
用户指令 / 图片 ──▶ Agent Skill ──▶ MCP (design_create → asset_upload → theme_patch
                                      → theme_validate → preview_start)
                                              │
                                              ▼
                              隔离 DSH 预览（真实渲染，不碰你的 DSH）
                                              │
                                              ▼
                          Studio 可见确认（theme_apply_plan → theme_apply）
                                              │
                                              ▼
                              你的 DSH 皮肤生效（可随时 Restore 还原）
```

---

## 🗂️ 目录结构

```
├─ install.ps1                     # 一键安装器（命令行 / AI）
├─ apps/
│  ├─ controller/                  # Studio 后端（API、隔离预览、apply/restore、GC）
│  └─ studio/                      # Studio Web UI（React + Vite）
├─ packages/
│  ├─ dsh-plugin/                  # DSH 插件（host 路由 + client 皮肤渲染）
│  ├─ theme-schema/                # ThemeSpec v2 数据契约
│  ├─ design-session-core/         # 设计会话 / 确认票据 / 操作日志
│  ├─ shared/                      # 跨端类型与错误码
│  ├─ agent-cli/                   # dsh-skin JSON CLI
│  ├─ mcp-server/                  # MCP stdio 服务器（26 个工具）
│  └─ portable-runtime/            # 便携运行时聚合
├─ agents/codex-skill/deepseek-harness-skin-studio/
│  ├─ SKILL.md                     # Agent Skill 指令（自动换肤流程）
│  └─ scripts/                     # open-studio / build-portable / install-local
├─ research/                       # 同类项目调研材料（16 个项目 README）
├─ docx/                           # 项目文档（实施计划 / 需求分析 / 架构设计）
└─ tests/                          # 回归测试（含真实 rc.6 隔离 Chromium 预览）
```

---

## 🛠️ 开发

```powershell
pnpm install          # 安装依赖（需要 Node 22+ / pnpm 11+）
pnpm build            # 构建全部包
pnpm test             # 回归测试（会启动真实 rc.6 隔离预览）
pnpm controller       # 本地启动 Controller（开发）
pnpm dev              # Studio 开发模式（Vite）
```

---

## 🗑️ 卸载

1. 移除 `%DSH_HOME%\profiles\<profile>\cordis.patch.yml` 中所有 `# >>> dsh-skin-studio` 与 `# <<< dsh-skin-studio` 注释块之间的条目；
2. 删除 `%DSH_HOME%\profiles\node_modules\@dsh-skin` 与 `%DSH_HOME%\skills\deepseek-harness-skin-studio`；
3. 重启 DSH；
4. 如需清理 Studio 数据，删除 `%LOCALAPPDATA%\DeepSeekHarnessSkinStudio`。

---

## 🔒 安全与兼容

- 目标 DSH 版本：`0.1.0-rc.6`（能力钉扎，版本不符时插件 fail-closed）。
- 皮肤模型（ThemeSpec）只允许结构化数据：字面量 CSS 颜色、内容寻址图片（sha256）、受控 token；**不接受任意 CSS/JS/URL**。
- 预览使用 Controller 拥有的**隔离临时 DSH**；确认与写入必须由可见 Studio 中的人工完成。
- 余额查询：API Key 只在 host 端解析（`DSH_SKIN_BALANCE_API_KEY` → `DEEPSEEK_API_KEY` → `%DSH_HOME%\.credentials.yaml`），浏览器只见聚合余额，密钥不落浏览器。

---

## 📄 文档

- `docx/` — 实施计划、需求分析说明书、技术架构设计说明书
- `CHANGELOG.md` — 变更记录
- `RELEASING.md` — 发布清单（GitHub Release / npm）

## 📃 License

[MIT](LICENSE) © 2026 trrrrrryg
