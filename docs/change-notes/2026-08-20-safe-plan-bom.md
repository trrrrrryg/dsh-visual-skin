# 安全计划生成修复（2026-08-20）

修复了 Windows PowerShell 旧安装记录带 UTF-8 BOM 时，Skin Studio 在读取 `installations/*.json` 或 `plugin-secrets/*.json` 生成安全计划会返回 HTTP 500 的问题。

`AtomicJsonStore` 现在兼容读取带 BOM 的既有 JSON；安装器仍持续写入 UTF-8 无 BOM 文件。已验证现有隔离预览的精确回执可以生成绑定的安全计划，且没有写入主题或绕过人工确认。
