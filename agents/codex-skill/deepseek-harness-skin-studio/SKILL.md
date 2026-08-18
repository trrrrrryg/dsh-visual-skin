---
name: deepseek-harness-skin-studio
description: Open and orchestrate the local DeepSeek Harness Skin Studio, co-design a structured DSH theme through MCP or JSON CLI, show live preview in the independent web UI, and safely apply or restore only after the human confirms in that visible UI. Use when the user asks to design, preview, change, inject, install, repair, or restore a DeepSeek Harness skin, or asks another Agent to connect to the same shared skin design session.
---

# DeepSeek Harness Skin Studio

Use the project-owned MCP tools when available. Keep all theme state in the shared DesignSession; never maintain a private copy in chat.

## Automatic skin creation

When the user asks to create or replace a skin (often with just a background image), drive the whole flow through MCP:

1. `design_create` (or load the active design with `theme_get` when the user wants to modify the current skin).
2. `asset_upload` the provided image (PNG/JPEG/WebP, up to 4 MiB) to get its content-addressed `assetId`.
3. `theme_patch` the design: set `appearance.backdrop` (and `regions.sidebar`/`regions.main` when split mode is wanted) to `{ kind: "image", assetId, fit, position, overlay }`, plus tasteful token overrides. Always use the current `baseRevision`; on `REVISION_CONFLICT` reload with `theme_get` and retry.
4. `theme_validate`, then `preview_start` so the user can see the new skin live in Studio (isolated DSH; it never touches the live profile).
5. Before persisting, present the apply plan and require the human to press Confirm in the visible Studio; after the user-controlled DSH restart, verify plugin health and the acknowledged revision/hash.

In DSH, the tools are exposed as `mcp__skin-studio__*` (doctor, design_create, asset_upload, theme_patch, theme_get, theme_validate, preview_start, theme_apply_plan, theme_apply, ...); in Codex they appear under the native names. Prefer these tools over manual file edits.

## Studio session flow

1. Run `scripts/open-studio.ps1` immediately. It validates the versioned runtime bundled inside this Skill, starts the Controller when needed, and opens the independent Studio. Report its copyable URL if automatic opening fails.
2. Run `doctor`, then use `studio_open` for subsequent opens in the same session.
3. Create or load a design, then use `theme_patch` with the current `baseRevision`. On `REVISION_CONFLICT`, reload with `theme_get`, reconcile, and retry.
4. Use `theme_validate`, `preview_start`, and `preview_snapshot` while designing. `preview_start` creates a Controller-owned, isolated actual DSH runtime under a temporary home; it never writes to, restarts, or loads the user's DSH profile. Wait for the current revision's `live` render receipt before proposing apply. The user may edit the same revision in the web UI.
5. Before apply or restore, ask the user to review the immutable apply plan and press Confirm in the visible Studio. The Studio itself performs the confirmed write only when the plan is bound to the current isolated preview session, generation, and render receipt. Never create, simulate, retrieve, transmit, or reuse a confirmation token.
6. Agents only observe `operation_status`. After the user-controlled DSH restart, verify plugin health and the acknowledged design revision/hash; never report success while the operation is pending verification.

For a Codex installation without MCP registration, run `scripts/open-studio.ps1`; its JSON output is authoritative. The installed Skill is self-contained and must not depend on the original source checkout. For other local Agents, follow `references/agent-integration.md` and connect to the same bundled STDIO MCP runtime.

Safety boundaries:

- Treat `USER_CONFIRMATION_REQUIRED`, `UNSUPPORTED_DSH_VERSION`, and `CAPABILITY_UNAVAILABLE` as hard stops.
- Do not edit official DSH distribution files or DSH session/credential data.
- Do not broaden ThemeSpec with arbitrary CSS, selectors, JavaScript, `@import`, URLs, or file paths.
- Keep preview bearer material only in the Controller-owned temporary DSH home. Do not inspect, log, persist, or reuse it.
- Use an explicit temporary `.dsh` home for development checks. Do not restart or modify a live user profile without explicit approval.
