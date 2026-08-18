# Codex Dream Skin｜Mac + Windows 梦幻皮肤

<p align="center">
  <strong>给 Codex 桌面端换一张会呼吸的脸。</strong><br>
  整窗自适应主题 · 本机 CDP 注入 · 不改官方 <code>app.asar</code> / 应用文件
</p>

> 🎁 **免费领取完整 Skill**<br>
> 前往 [世事宜AI · 免费工具](https://ssyai.xytpark.cn/purchase)，选择 **Codex Dream Skin**。领取后，完整 ZIP 会自动发送到收货邮箱。也可直接从 [GitHub Releases](https://github.com/xnydl/codex-dream-skin/releases/latest) 下载。

![世事宜梦境 预设背景](macos/presets/preset-ssyai-dream/background.jpg)

## v2.0 能做什么

- **真·可交互**：侧栏、建议卡、项目选择器、输入框都是 Codex 原生控件，不是整窗假截图
- **整窗真背景**：一张 16:9 壁纸连续铺满整窗，首页突出氛围，任务页自动降低干扰
- **换图即主题**：导入任意纯背景图，本地 Canvas 自动分析亮度、主色、焦点与安全区，生成自适应配色（图片不上传）
- **亮暗自动**：`appearance: auto` 跟随 Codex / 系统外观，浅色暗色都可读
- **可存可切**：macOS 菜单栏（SwiftBar）与 Windows 系统托盘都能保存 / 热切换本地主题，不用重启 Codex
- **6 套内置预设**：置顶「世事宜梦境」+ 午夜极光 / 樱粉晨曦 / 琥珀黄昏 / 森野薄雾 / 赛博霓虹（全部程序化生成，无照片、无第三方 IP）
- **一键恢复**：Restore 还原官方外观并关闭调试端口
- **相对安全**：CDP 只绑 `127.0.0.1`，安装 / 启动 / 恢复全程校验官方应用签名与进程身份

## 快速开始

| 平台 | 目录 | 入口 |
|------|------|------|
| macOS（Apple Silicon / Intel） | [`macos/`](./macos/) | 双击 `Install Codex Dream Skin.command` |
| Windows（Microsoft Store 版 Codex） | [`windows/`](./windows/) | `scripts/install-dream-skin.ps1` → `scripts/start-dream-skin.ps1` |

macOS 从仓库安装并切换置顶预设：

```bash
cd macos
./scripts/install-dream-skin-macos.sh --no-launch
~/.codex/codex-dream-skin-studio/scripts/switch-theme-macos.sh --id preset-ssyai-dream
```

Windows 首次使用：

```powershell
powershell -ExecutionPolicy Bypass -File .\windows\scripts\install-dream-skin.ps1
powershell -ExecutionPolicy Bypass -File .\windows\scripts\start-dream-skin.ps1
```

安装后 Windows 默认即为「世事宜梦境」，托盘可换背景图、保存与切换主题、暂停或完整恢复。

一键导入 Skill（配合支持 skills 的 agent 使用）：

```bash
npx skills add xnydl/codex-dream-skin -g -y
```

也可以把整个 ZIP 直接交给 Codex，让它按 [`macos/CLIENT_DEPLOY_PROMPT.md`](./macos/CLIENT_DEPLOY_PROMPT.md) 自动部署。

## 环境要求

- macOS：官方 Codex 桌面版（`ChatGPT.app` 或 `Codex.app`），至少启动过一次；无需全局 Node（复用官方应用内置签名 Node）
- Windows：Microsoft Store 安装的 Codex 桌面版 + Node.js 22 LTS + Windows PowerShell
- 换自己的图：推荐 `2560 × 1440`（16:9）纯背景，主视觉放右侧、左侧留低信息区；参考 [生图提示词模板](./docs/reference-background-prompt-guide.md)

## 更细的说明

- macOS：[`macos/README.md`](./macos/README.md)（含菜单栏、自定义主题、自适应字段）
- Windows：[`windows/SKILL.md`](./windows/SKILL.md)
- 路径对照：[`docs/platforms.md`](./docs/platforms.md)
- 预设规范与贡献：[`macos/presets/README.md`](./macos/presets/README.md)

## 安全边界

- 不替换、不接管、不修改任一平台的 Codex 官方程序文件与签名
- CDP 只绑 `127.0.0.1`；主题运行期间勿运行来路不明的本机程序，不用时执行 Restore
- 不会自动改写 API Key / Base URL；换肤与模型供应商配置互相独立

## 许可与致谢

- 代码以 MIT 许可发布，见 [`LICENSE`](./LICENSE) 与 [`macos/NOTICE.md`](./macos/NOTICE.md)
- v2.0 引擎基于开源项目 [Fei-Away/Codex-Dream-Skin](https://github.com/Fei-Away/Codex-Dream-Skin)（Codex Dream Skin Studio，MIT），感谢原作者；本发行版移除了上游非 MIT 素材并替换默认预设与品牌位
- 非 OpenAI 官方产品；Codex 及相关商标归其权利人所有

---

由 [世事宜AI](https://ssyai.xytpark.cn/purchase) 免费提供 · 有问题欢迎提 Issue
