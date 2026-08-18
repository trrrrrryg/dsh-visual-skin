# 发布检查清单（Publishing checklist）

把本项目发布到 GitHub 前，逐项确认：

## 1. 法律与标识

- [ ] 添加 `LICENSE`（建议 MIT，与 `@deepseek-ai/dsh` 一致；本项目代码原创，无第三方内嵌资产）
- [ ] `README.md` 已更新：截图（Studio 界面、DSH 应用效果）、徽章（可选）、安装/使用/开发/卸载
- [ ] 英文 README（`README.en.md`）或双语段落（生态内多数项目提供中英双文）
- [ ] 仓库 `description`、`topics`（`deepseek-harness`、`dsh-plugin`、`theme`、`skin`、`mcp`、`skill`）

## 2. 敏感信息与隐私（发布前必须）

- [ ] 全仓库搜索：`s04XPl`（插件 secret）、`OMNIROUTE_API_KEY`、`DEEPSEEK_API_KEY`、`pluginSecret`、`sk-` —— **不得出现在任何提交文件**（`install.ps1` 运行时生成 secret，不含静态值）
- [ ] `%LOCALAPPDATA%\DeepSeekHarnessSkinStudio` 内容不进仓库（本机数据，非仓库内）
- [ ] `.gitignore` 已覆盖：`node_modules/`、`dist/`、`.tmp/`、`*.log`、`test-results/`、`playwright-report/`、`docx/_rendered*`、`.docx-qa*`、`__pycache__/`
- [ ] 确认 `agents/.../runtime/` 是否随仓库发布：若随仓库发布，`install.ps1` 用 `-SkipBuild` 即可安装；若排除，用户需自行构建（README 写明前置：Node 22+ / pnpm）
- [ ] `capabilities/0.1.0-rc.6.json` 中无用户路径/密钥（当前仅记录观察到的选择器与契约，安全）

## 3. 构建与自检

- [ ] `pnpm install && pnpm build && pnpm typecheck` 全绿
- [ ] `pnpm test`（全量）通过；环境无 npm 网络时注明部分集成测试依赖 Corepack 下载 pnpm
- [ ] 干跑 `install.ps1 -DshHome <临时路径> -SkipStudio -SkipCodexMcp -SkipBuild`，确认输出 JSON 且 patch 无源路径泄漏（`grep -r "ruanjianproject"` 安装产物应为空）

## 4. 发布形态

- [ ] 决定发布方式：
  - GitHub Release 附 `deepseek-harness-skin-studio.zip`（含完整 skill 目录 + `install.ps1` + README，用户解压后运行 `install.ps1` 或让 AI 读取安装）
  - 或仅仓库 + 文档（用户 clone 后运行 `install.ps1`）
- [ ] 若走 npm（生态内 `dsh-dream-skin`、`dsh-skin` 均在 npm）：为 `@dsh-skin/*` 包补 `LICENSE`/`repository`/`description`，用 `pnpm publish` 发布 `dsh-plugin`（DSH 官方插件体系支持 `dsh plugin add` 远程安装）；`install.ps1` 可加 `-FromNpm` 分支

## 5. CI（建议）

- [ ] GitHub Actions：`pnpm install → build → typecheck → test`（Windows runner；集成测试需 `playwright` 浏览器）
- [ ] 发布 workflow：打 tag 时构建 portable runtime → 上传 Release asset

## 6. 版本与升级

- [ ] `version` 字段统一（`0.1.0`）；`CHANGELOG.md` 保留
- [ ] 升级路径：`install.ps1` 幂等可覆盖升级；`runtime.local.json` 记录 `installedAt`，可加版本比对提示

## 7. 已知边界（README 中披露）

- 目标 DSH `0.1.0-rc.6`；DSH 升级后插件 fail-closed（不破坏 DSH，但皮肤失效，需重新适配选择器）
- 余额功能依赖 DSH 侧 `.credentials.yaml` 的 `DEEPSEEK_API_KEY`；密钥只留在 DSH 进程内
