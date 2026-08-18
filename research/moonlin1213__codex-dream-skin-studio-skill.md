# Codex Dream Skin Studio Skill

[English](README.en.md) | 简体中文

[![Validate](https://github.com/moonlin1213/codex-dream-skin-studio-skill/actions/workflows/validate.yml/badge.svg)](https://github.com/moonlin1213/codex-dream-skin-studio-skill/actions/workflows/validate.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

一个面向 Codex 的开源 Skill：给它一张人物图、风格图或氛围参考图，它会先分析主体、构图、色彩、材质与光线，再询问你想要的视觉方向，生成与 Codex 原生界面协调的完整主题方案，并通过 [Codex Dream Skin](https://github.com/Fei-Away/Codex-Dream-Skin) 安全打包和应用。

本仓库提供的是 AI 工作流和验证工具，不包含 Codex Dream Skin 引擎、第三方生图服务、API 密钥、真人肖像或主题壁纸。

> **重要运行限制与便捷方案**：主题文件会保存在 Dream Skin 引擎的本地主题库中，但皮肤本身由外部注入器应用到当前 Codex 进程。完全退出后，从官方 Codex 图标重新打开可能显示默认外观，这不是本 Skill 丢失了主题。为此，本 Skill 同时提供 macOS `.command` 和 Windows `.lnk` 双击入口生成器：重开 Codex 后双击一次，就会读取并应用最近一次保存或选择的皮肤；不需要手动输入终端命令，也不会安装后台常驻服务。详见[重开后如何恢复最近皮肤](#重开-codex-后如何保持皮肤)。

> **特别感谢**：这套 Skill 的主题运行、打包与切换能力建立在 [Fei-Away/Codex-Dream-Skin](https://github.com/Fei-Away/Codex-Dream-Skin) 开源项目之上。感谢 Fei-Away 和所有 Codex-Dream-Skin 贡献者公开实现、文档与背景构图方法，让这套从参考图到一键换装的工作流成为可能。请在使用、修改或分享本 Skill 时保留这份感谢与上游链接。

## 2026-08-03 双平台兼容说明

- 本 Skill 现在明确要求 macOS Dream Skin 引擎 `1.2.2` 或更高版本，才能适配官方 ChatGPT/Codex Desktop `26.727.51351`（build `6119`，Chromium `150.0.7871.182`）。
- 这次不是单纯文档更新：官方桌面端新版 shell 会忽略默认 profile 的远程调试参数，并且新对话首页不再暴露旧的 `main.main-surface` 布局。旧 `1.2.1` 引擎可能出现主题已保存但无法 live 注入、或新对话标题/卡片/composer 错位的问题。
- macOS 双击入口会拒绝 `1.2.1` 及更旧引擎，并提示先更新 engine。请直接使用 [Fei-Away/Codex-Dream-Skin](https://github.com/Fei-Away/Codex-Dream-Skin) 上游 `v1.5.11` 或更新版本；该版本已经包含 `1.2.2` 兼容线及后续 Codex `26.727` 修复。
- Windows 版仍然保留完整支持，但同样不能只安装 Skill。本 Skill 的 Windows 脚本会调用 `%LOCALAPPDATA%\CodexDreamSkin\engine` 中的受管 Windows engine、`stage-theme-windows.ps1`、`.lnk` 安全包装和 `verify-dream-skin.ps1`；更新 Skill 后，Windows 用户也应从同一份最新 Dream Skin engine 源码重新运行 Windows 安装器，让快捷方式和受管运行时保持一致。
- 已用 `Quiet Grid / Agnes Martin Inspired` 在官方 `26.727.51351` 上验证：CDP 端口可用，新对话首页不再空白或重叠，标题回到左上视觉区并与建议卡片自然对齐。

## 2026-07-25 macOS 兼容性热修复与双平台入口加固

- macOS 双击入口现在要求 Dream Skin 引擎 `1.2.1` 或更高版本；检测到已知会在新版 Codex 上丢失 CDP、长时间停留在“正在应用”的 `1.2.0` 时会立即停止并给出升级提示，不再进入重试转圈。
- 配套 macOS `1.2.1` 运行时统一进程启动时间格式、兼容识别旧版本地化状态，并改为先验证真实调试端口；LaunchServices 确实丢掉参数时才通过官方已签名可执行文件回退一次，旧版 `Codex.app` 与新版 `ChatGPT.app` 均保留支持。
- macOS 与 Windows 应用入口在失败时都会明确说明“主题仍已保存，只是实时注入未生效”，并禁止无条件重试循环。
- Windows `.lnk` 现在经过 Skill 的 `apply-last-theme-windows.ps1` 安全包装脚本，再委托给受管引擎并保留单次 `-PromptRestart` 确认；更新后请重新生成一次 Windows 快捷方式。
- 新增中英文区域、LaunchServices 延迟可见、旧版状态升级、macOS 引擎版本门槛和 Windows 失败语义回归测试。

## 2026-07-20 双平台升级

本次更新把原本以 macOS 为主的自动化流程升级为完整的 **macOS + Windows 双平台工作流**：

- 新增 Windows Skill 安装器 `install.ps1`，支持安全安装、拒绝隐式覆盖和 `-Force` 备份更新。
- 新增 Windows 主题 staging、保存、列举和切换脚本；默认不启动或重启 Codex，只有显式传入 `-Apply` 才进入带确认的应用流程。
- 新增 Windows `.lnk` 双击入口生成器，使用 `RemoteSigned` 并通过 Skill 安全包装脚本保留上游引擎的 `-PromptRestart` 确认。
- 壁纸验证器改为纯 Node.js 跨平台实现，macOS 和 Windows 现在使用同一套 PNG/JPEG/WebP、`2560x1440`、16 MB 校验规则。
- 新增 `windows-latest` GitHub Actions 检查，覆盖 Windows 安装、备份、快捷方式参数、主题 staging、保存和切换。
- 原有 macOS `.command` 入口、主题制作、安全切换和恢复流程保持兼容。

## 它能做什么

- 从一张参考图提取人物、色板、材质、光线、构图与视觉重心。
- 主动询问风格方向，例如可爱卡通、简洁高级、Le Labo 极简、赛博朋克、低饱和莫兰迪或艺术感。
- 将参考图转换成真正的纯背景生成提示词，而不是伪造 Codex 截图。
- 固定左侧内容安全区和右侧视觉焦点，兼顾浅色、深色以及常见窗口比例。
- 在 macOS 和 Windows 上用同一份纯 Node 验证器校验 PNG/JPEG/WebP 母版是否为 `2560x1440`、是否低于 16 MB。
- 生成 `theme.json + background.jpg` 主题包，并将主题制作与应用分开。
- 检查 Dream Skin 会话状态，避免反复重启 Codex。
- 在 macOS 或 Windows 上生成双击入口，用于重开后恢复最近一次皮肤。
- 可选生成头像、贴纸、徽章和预览图，并明确哪些素材当前不会被渲染器直接显示。

## 工作流程

```text
一张参考图
    ↓
分析主体、色彩、材质、光线与构图
    ↓
询问并确认风格方向与肖像授权
    ↓
生成 2560x1440 纯背景及可选素材
    ↓
尺寸、裁切、浅暗蒙层与 UI 污染检查
    ↓
打包并 staging 主题（不自动应用）
    ↓
检查运行状态后安全换装
```

## 前置要求

- macOS Codex 桌面应用，或从 Microsoft Store 安装并注册到当前用户的 Windows `OpenAI.Codex` 应用。
- 已单独安装对应平台的 Dream Skin 引擎。macOS 官方 ChatGPT/Codex Desktop `26.727.51351` 要求包含新版 profile/CDP 与首页布局修复的 `1.2.2` 或更高版本；当前推荐直接使用 [Fei-Away/Codex-Dream-Skin](https://github.com/Fei-Away/Codex-Dream-Skin) 上游 `v1.5.11+`。Windows 用户也需要从同一上游 Dream Skin engine 仓库安装/更新 Windows engine，不能只安装本 Skill。
- Codex 或其他兼容 Agent 环境支持本地 Skills。
- Node.js 18 或更高版本用于本 Skill 的壁纸验证；Windows Dream Skin 引擎本身要求 Node.js 22 或更高版本。
- Windows 用户还需要 Windows PowerShell 5.1 或更高版本；普通使用不需要管理员权限。
- 一个你有权使用的生图工具或图片生成服务。Skill 不绑定任何 Provider，也不保存密钥。

## 安装

### macOS / Linux 一键安装

```bash
git clone https://github.com/moonlin1213/codex-dream-skin-studio-skill.git
cd codex-dream-skin-studio-skill
./install.sh
```

如果目标目录已存在，安装脚本会停止，不会静默覆盖。确认要更新时使用：

```bash
./install.sh --force
```

### Windows 一键安装

在 PowerShell 中进入仓库目录后运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

如果目标目录已存在，安装器会停止。确认要备份并更新时使用：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Force
```

这里的 `Bypass` 只作用于这一次由用户明确发起的安装进程。安装器不会修改持久执行策略；它只在复制完成后清除 Skill 受管 PowerShell 副本的下载区标记，日常入口使用 `RemoteSigned`。

这条命令安装的是 AI Skill，不包含运行时引擎。尚未安装 Windows Dream Skin 引擎时，再按上游 [Windows 安装说明](https://github.com/Fei-Away/Codex-Dream-Skin/blob/main/windows/README.md)操作；在上游仓库根目录可运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\windows\scripts\install-dream-skin.ps1
```

引擎安装器会检查官方 Store 包和 Node.js 22+，把运行时复制到 `%LOCALAPPDATA%\CodexDreamSkin\engine`，并创建启动、托盘和恢复快捷方式。请先完全退出 Codex；不需要管理员权限，也不要接管 `WindowsApps`。

### 手动安装

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
cp -R codex-dream-skin-studio \
  "${CODEX_HOME:-$HOME/.codex}/skills/codex-dream-skin-studio"
```

安装后新建一个 Codex 任务即可调用。只有 Skill 没有出现在列表中时，才需要完整退出并重新打开 Codex 一次，不要反复重启。

### 创建重开后的双击入口（推荐）

#### macOS

Dream Skin 引擎安装完成后，可以运行一次下面的辅助脚本。它默认在 `Downloads` 里生成 `Apply Last Codex Dream Skin.command`：

```bash
SKILL_ROOT="${CODEX_HOME:-$HOME/.codex}/skills/codex-dream-skin-studio"
"$SKILL_ROOT/scripts/install-reopen-launcher-macos.sh"
```

也可以让 Codex Agent 把入口放到你指定的文件夹并使用中文名称：

```bash
"$SKILL_ROOT/scripts/install-reopen-launcher-macos.sh" \
  --output-dir "$HOME/Downloads/codex" \
  --name "应用最近的 Codex 皮肤.command"
```

入口只需要创建一次。以后更换皮肤时不需要重建；它读取的是 Dream Skin 引擎中最近一次保存或选择的主题，不会写死某一套皮肤。已有同名入口时脚本默认停止，只有明确希望备份并替换时才使用 `--force`。

#### Windows

Windows Dream Skin 引擎安装器默认已经在桌面和开始菜单创建 `Codex Dream Skin` 快捷方式。本 Skill 还可以在 `Downloads` 或任意常用文件夹生成同样安全的自定义入口：

```powershell
$CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$SkillRoot = Join-Path $CodexHome 'skills\codex-dream-skin-studio'
& "$SkillRoot\scripts\install-reopen-launcher-windows.ps1"
```

指定目录或中文名称：

```powershell
& "$SkillRoot\scripts\install-reopen-launcher-windows.ps1" `
  -OutputDirectory (Join-Path $HOME 'Downloads\codex') `
  -Name '应用最近的 Codex 皮肤.lnk'
```

已有同名 `.lnk` 时脚本默认拒绝覆盖；只有用户明确同意备份并替换时才传 `-Force`。快捷方式使用 `RemoteSigned`，直接指向 Windows 引擎的受管运行时，并以 `-PromptRestart` 保护一次受控重启；以后更新 Skill 不需要重建入口。

## 使用

上传一张图片，然后直接说：

```text
用 $codex-dream-skin-studio，把这张图做成一套可以一键换装的 Codex 皮肤。
```

也可以给出更明确的方向：

```text
用 $codex-dream-skin-studio，参考这张图的人物和冷灰色调，做一套低饱和、简洁高级的 Codex 皮肤。保留人物神态，但不要复制图片里的文字或界面。
```

```text
用 $codex-dream-skin-studio，只参考这张图的材质和配色，做成 Le Labo 式克制极简风。人物改成原创成年角色。
```

如果你没有指定风格，Skill 会先给出一个紧凑的风格选择。涉及真人身份保留时，它会要求你确认拥有必要的肖像与素材使用权；未确认时默认生成原创成年人物。

## 输出标准

主题母版必须满足：

- `2560x1440`、16:9、完整不透明的独立背景图。
- 左侧 `x=0%-52%` 是低信息内容安全区。
- `x=45%-62%` 自然过渡，不出现垂直拼接线。
- 右侧 `x=62%-88%` 放置人物或主要焦点。
- 关键内容位于 `y=16%-72%`，并距边缘至少 8%。
- 不包含窗口、侧栏、卡片、按钮、输入框、光标、可读文字、Logo、签名或水印。

验证母版：

```bash
node "${CODEX_HOME:-$HOME/.codex}/skills/codex-dream-skin-studio/scripts/validate-wallpaper.mjs" \
  --file "/path/to/background.png"
```

Windows PowerShell：

```powershell
$CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$SkillRoot = Join-Path $CodexHome 'skills\codex-dream-skin-studio'
node "$SkillRoot\scripts\validate-wallpaper.mjs" --file 'C:\path\to\background.png'
```

验证器直接在 Node.js 中读取 PNG、JPEG 和 WebP 尺寸，不依赖 macOS `sips`、ImageMagick 或 Windows 图像工具。

## 安全换装原则

Skill 默认使用 Dream Skin 的 staging 流程：先生成和保存主题，再由用户决定何时应用。

macOS：

```bash
ENGINE="$HOME/.codex/codex-dream-skin-studio"
"$ENGINE/scripts/status-dream-skin-macos.sh" --json --deep
"$ENGINE/scripts/switch-theme-macos.sh" --id <theme-id> --no-apply
```

只有 `session=active`、`injectorAlive=true`、`cdpOk=true` 时才直接热切换。如果 Codex 正在运行但 `cdpOk=false`，Skill 不会循环调用重启命令，也不会静默结束 Codex 进程。

Windows：

```powershell
$CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$SkillRoot = Join-Path $CodexHome 'skills\codex-dream-skin-studio'
$Engine = Join-Path $env:LOCALAPPDATA 'CodexDreamSkin\engine'

& "$SkillRoot\scripts\stage-theme-windows.ps1" `
  -Image 'C:\path\to\background.png' `
  -Name 'Theme name' `
  -ThemeJson 'C:\path\to\theme.json'
& "$SkillRoot\scripts\switch-theme-windows.ps1" -List
& "$Engine\scripts\verify-dream-skin.ps1" `
  -ScreenshotPath (Join-Path $env:TEMP 'codex-dream-skin.png')
```

`stage-theme-windows.ps1` 默认只更新活动主题并保存一份自包含主题，不会启动或重启 Codex；`switch-theme-windows.ps1` 默认也只 staging。只有在用户同意可能出现的一次重启确认后才传 `-Apply`。验证失败时保留 `%LOCALAPPDATA%\CodexDreamSkin\active-theme`，查看 `state.json`、`verify.log` 和 injector 日志，不循环使用 `-RestartExisting`。

恢复 Windows 官方外观并关闭已保存的 CDP 会话：

```powershell
& "$Engine\scripts\restore-dream-skin.ps1" -RestoreBaseTheme -PromptRestart
```

也可以双击引擎安装器创建的 `Codex Dream Skin - Restore` 快捷方式。只有明确要同时删除 Dream Skin 快捷方式时才加 `-Uninstall`。

## 重开 Codex 后如何保持皮肤

Dream Skin 当前使用外部回环注入器，不会修改 Codex 应用包。这里有两个不同的“持久化”概念：

- **主题文件会持久保存**：已经制作或选择的 `theme.json + background.jpg` 不会因为退出 Codex 而丢失。
- **实时注入会话不会随普通启动自动恢复**：完全退出 Codex 会结束调试端口和注入器。直接点击官方 Codex 图标重新打开时，Codex 没有通过 Dream Skin 引擎启动，因此会显示默认界面。

这属于已安装的 [Codex Dream Skin](https://github.com/Fei-Away/Codex-Dream-Skin) 引擎及启动方式的运行时边界，不是本 Skill 的主题生成、打包或验证故障。本 Skill 只有在被 Agent 调用时才会运行，无法在 Codex 启动之前常驻，也不包含 `LaunchAgent`、注入器或自动启动服务。

### 当前推荐方案：双击恢复最近皮肤

这是一种比每次手动输入终端命令更方便、又比未经验证的后台常驻更保守的方式：

1. 先安装 Codex Dream Skin 引擎，并使用本 Skill 制作、保存和应用主题。
2. 按上面的[创建重开后的双击入口](#创建重开后的双击入口推荐)步骤，把 `.command`（macOS）或 `.lnk`（Windows）入口放进 `Downloads`、项目文件夹或其他容易找到的位置。
3. 以后即使从官方图标重新打开 Codex、看到默认界面，也不代表主题丢失。双击 `Apply Last Codex Dream Skin.command`、`Apply Last Codex Dream Skin.lnk`，或你为它设置的中文名称。
4. 如果普通 Codex 已经运行但没有 Dream Skin 所需的 CDP，入口会弹出一次“重启并应用”确认。确认后，它会受控地重启一次、连接注入器，并应用最近一次保存或选择的主题。
5. 如果 Codex 尚未运行，入口会直接通过 Dream Skin 引擎启动。入口不会注册 `LaunchAgent`、不会后台监控 Codex，也不会静默强制结束正在运行的应用。

“最近一次皮肤”来自引擎当前的 live theme 目录。因此以后主动换成另一套主题，下一次仍使用同一个入口即可，不需要修改脚本或重新创建入口。

如果安装的 Skill 版本没有入口生成器，才使用下面的手动兜底，并且只调用一次：

```bash
ENGINE="$HOME/.codex/codex-dream-skin-studio"
"$ENGINE/scripts/start-dream-skin-macos.sh" --prompt-restart
```

不要把这条命令放进重试循环。一次启动失败时，应先查看状态和引擎日志。

Windows 的手动兜底同样只调用一次：

```powershell
& "$env:LOCALAPPDATA\CodexDreamSkin\engine\scripts\start-dream-skin.ps1" -PromptRestart
```

Windows 启动后运行一次 `verify-dream-skin.ps1`。活动主题存在但端点验证失败时，含义同样是“主题已保存、实时注入未生效”，不是主题丢失。

启动后可以检查实时状态：

```bash
ENGINE="$HOME/.codex/codex-dream-skin-studio"
"$ENGINE/scripts/status-dream-skin-macos.sh" --json --deep
```

只有下面三项同时成立，才表示当前进程中的皮肤已经恢复：

```text
session=active
injectorAlive=true
cdpOk=true
```

如果状态是 `session=stale`、`injectorAlive=false` 或 `cdpOk=false`，但 `themeName` 仍然存在，通常表示主题文件还在，只是注入没有在当前进程中生效。请双击重开入口一次，并按提示确认一次受控重启；不要循环强制重启。

### 如果希望官方 Codex 图标也能自动恢复

完全不经用户双击、仅靠官方 Codex 图标自动恢复，仍需要 Dream Skin 引擎提供可靠的重开检测、启动包装或受支持的常驻机制。它必须由引擎层实现。在上游引擎正式支持前，本项目不会修改 Codex 的 `.app`、`app.asar`、代码签名，也不会声称普通 Codex 启动已经支持自动常驻。这里提供的入口是明确由用户触发的恢复方式。

## 仓库结构

```text
.
├── codex-dream-skin-studio/
│   ├── SKILL.md
│   ├── agents/openai.yaml
│   ├── references/
│   │   ├── background-method.md
│   │   └── runtime-contract.md
│   └── scripts/
│       ├── validate-wallpaper.mjs
│       ├── apply-last-theme-macos.command
│       ├── install-reopen-launcher-macos.sh
│       ├── apply-last-theme-windows.ps1
│       ├── install-reopen-launcher-windows.ps1
│       ├── stage-theme-windows.ps1
│       └── switch-theme-windows.ps1
├── tests/
│   ├── check-package.sh
│   ├── check-windows-package.ps1
│   └── validate-wallpaper.test.mjs
├── install.sh
├── install.ps1
├── README.md
├── README.en.md
├── NOTICE.md
└── LICENSE
```

## 隐私与版权

- 不要把 API Key、访问令牌、Cookie 或 Provider 配置提交到仓库。
- 不要公开你无权再分发的真人照片、商业素材、品牌资产或生成结果。
- 参考图只用于提取已经授权的视觉信息；公开图片不自动授予肖像权、角色权或再分发权。
- 默认使用原创成年人物，不诱导模型模仿未授权真人、公众人物、受版权保护角色或在世艺术家的标志性风格。
- 公开主题前，请自行复核图片生成服务条款以及素材来源的许可范围。

安全问题请参阅 [SECURITY.md](SECURITY.md)，贡献方式请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 与其他项目的关系

本项目是独立的社区 Skill，不隶属于 OpenAI，也不是 Fei-Away/Codex-Dream-Skin 的官方组件。再次感谢 [Fei-Away/Codex-Dream-Skin](https://github.com/Fei-Away/Codex-Dream-Skin) 项目及其贡献者。运行时依赖和背景构图方法来源说明见 [NOTICE.md](NOTICE.md)。

## License

[MIT](LICENSE)
