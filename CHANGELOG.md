# Change notes

## 2026-08-20 — Complete Open Platform quota history and Codex-style usage view

- Added a full 2024-01-to-current-month import from the signed-in DeepSeek Open Platform browser session, including daily input/cache/output tokens, cost, request counts, and per-model totals. The importer understands Chromium LevelDB WAL/table records, rejects ambiguous multi-profile accounts, and never persists the session token in a plugin credential file.
- Upgraded the local usage ledger to a transactional v2 schema with separate local and official buckets, migration/corruption backups, serialized writes, idempotent official replacement, and official-data precedence without discarding live local observations.
- Rebuilt the settings page around a five-segment Codex-style summary, a rolling 12-month daily activity grid, and a ranked model breakdown. Added keyboard navigation, detailed accessible labels/tooltips, sync states, and compact responsive sizing for the Harness settings dialog.
- Real account verification: all 32 months from 2024-01 through 2026-08 synchronized with zero failed months; a repeat synchronization produced the same totals. Full suite: 40/40 green; quota-specific suite: 11/11 green; reviewer reported no remaining findings.

## 2026-08-19 — Fix settings card crash (React element contract)

- **Root cause**: the settings card factory returned a raw `HTMLLIElement` (plain-DOM attempt to avoid `react/jsx-runtime`), but DSH's slots renderer mounts `settings.plugin.item` entries as **React children** — a DOM node crashes with `Minified React error #31` and the slot entry is dropped ("皮肤设置" card disappeared while balance/backdrop features kept working).
- **Fix**: the card is back to a React element. `require("react")` + `require("react/jsx-runtime")` resolve inside the DSH module loader exactly like DSH's own settings plugins (verified: builtin packages use the same requires), and the version row now uses `useState`/`useEffect` hooks instead of a mount-polling MutationObserver.
- Verified in real Chromium: opening 设置 → 插件 shows the "皮肤设置" card with "当前版本 v0.2.0 · 已是最新"; no React slot crash.

## 2026-08-19 — Version bar + one-click update in the settings card

- **New feature**: the DSH settings card now shows a version row ("当前版本 vX.Y.Z") and, when a newer GitHub release exists, a "一键更新" button.
- Host: `/dsh-skin/version` queries `api.github.com/repos/trrrrrryg/dsh-visual-skin/releases/latest` (30 min cache, prerelease/draft ignored), compares dotted versions, and returns `{ current, latest, updateAvailable, releaseUrl, downloadUrl, notes }`. `/dsh-skin/update` downloads the tagged source archive, extracts it with `tar`, verifies the packaged runtime/plugin are built and the version matches the release, swaps the installed skill's `runtime` with a rollback backup, then restarts the Controller.
- Client: the version row mounts via MutationObserver (waits for the card to actually connect — a microtask fired too early and left the row stuck at "版本检测中…"), fetches with `location.origin` + a 15 s abort timeout, and offers the update button only when `updateAvailable`.
- Version bumped to 0.2.0 across all packages; `v0.2.0` GitHub release created. Health route now reports the real plugin version.
- Verified: `/dsh-skin/version` returns correct JSON from the running DSH; the mount-wait logic fires the version fetch only after the card is attached and renders "发现新版本 v0.3.0" for an updateAvailable payload.

## 2026-08-19 — Fix isolated preview in installed runtime (plugin source resolution)

- **Root cause**: after moving to the portable installed runtime, `resolvePluginSource()` defaulted to `<projectRoot>/packages/dsh-plugin`, where `projectRoot` resolves from the dist module as `<runtime>/node_modules` — the embedded plugin actually lives at `<runtime>/plugin` (sibling of `node_modules`). Every isolated preview then failed at provisioning with `DSH_SKIN_PLUGIN_SOURCE does not contain a built managed plugin`, so Studio showed "隔离预览未能建立" and no design could be previewed.
- **Fix**: plugin source resolution now probes candidates in order — explicit `DSH_SKIN_PLUGIN_SOURCE` (if set), then the source-checkout path, then the installed-runtime embedded `<runtime>/plugin` path — validating package name and `dist/host/index.js` for each.
- Verified: with the runtime-installed Controller, an isolated preview now reaches `awaiting-render` and Studio reaches live with the real design rendered in the iframe.

## 2026-08-19 — Settings card auto-starts the Studio Controller when down

- **Root cause**: the DSH settings card's "启动并打开 Skin Studio" link redirects to the Controller (`http://127.0.0.1:11862`). The Controller is a separate process the installer starts once; after a reboot or a crash it stays down, so the card produced "无法访问此页面" with no recovery path.
- **Fix (host)**: `/dsh-skin/studio` now probes the Controller first (`/api/v1/status`); when it is unreachable and the plugin config carries `controllerEntry` + `dataDir` (written by `install.ps1`), the Host spawns the Controller with `DSH_SKIN_PORT` / `DSH_SKIN_DATA_DIR` inherited and waits up to 12 s for health before redirecting. A failed start returns a readable 503 instead of a dead redirect.
- **install.ps1**: the managed `cordis.patch.yml` block now records `controllerEntry` and `dataDir` for the auto-start path.
- Verified: with the Controller killed, the studio route reports unavailability until the config is present, then spawns and redirects successfully; Studio health 200.

## 2026-08-18 — DSH settings card opens Studio in a new tab only (no hijack)

- **Root cause**: the settings card used `window.open("/dsh-skin/studio", "_blank", "noopener,noreferrer")` with a `window.location.assign("/dsh-skin/studio")` fallback. When the popup was blocked (or returned null), the fallback navigated the live DSH tab itself to Studio, producing two Studio tabs.
- **Fix**: the card now renders a native `<a href="/dsh-skin/studio" target="_blank" rel="noopener noreferrer">` — a user-gesture anchor can never navigate the current tab, so the DSH page stays put and exactly one Studio tab opens.
- Verified in real Chromium: DSH tab URL unchanged after click; one new tab at the Controller URL.

## 2026-08-18 — Studio: instant preview switching between skins (no refresh)

- **Root cause**: switching designs killed the previous warm runner and cold-provisioned a new isolated DSH; the old verified frame stayed on a dead URL while the new session waited for a render receipt that never came — the candidate (warming) frame was styled `1px × 1px + clip-path: inset(50%)`, which collapses its layout to zero width, so the isolated DSH client could not discover its regional surfaces and never posted the rendered receipt. The session stayed `awaiting-render` forever and only a full page refresh (which re-runs bootstrap and points the main frame at the new session) made the skin appear.
- **Fix 1 (CSS)**: `.preview-candidate-frame` is now `position:absolute; inset:0; opacity:0; pointer-events:none` — full-size invisible overlay, so the warming frame renders at a real viewport size and the receipt flow completes.
- **Fix 2 (workbench)**: when the candidate session belongs to a different design than the verified one, the main frame now points at the candidate's URL as soon as it exists (loading placeholder before that) instead of keeping the dead verified frame on screen.
- Verified in a real browser: clicking skin #2 → #3 → #1 switches the rendered preview in ~2–4 s each without a refresh; full suite 28/28 green.

## 2026-08-18 — Audit fixes (preview divider, installer BOM, GC, boundaries)

- **Preview divider now renders after a PATCH** (real bug): the persistent stylesheet is a page-load snapshot generated by the Host, so a preview session that PATCHes `divider: true` after load used to drop the divider entirely (client skipped the DOM decoration because the base existed, but the snapshot had no `::after` rule). Preview mode now always owns the boundary in the DOM and neutralizes the stale snapshot rule; stable mode keeps the stylesheet-owned divider.
- **install.ps1 no longer writes UTF-8 BOMs** (P1): PowerShell 5.1's `Set-Content -Encoding UTF8` writes a BOM, which made `JSON.parse` of `plugin-secrets/<profile>.json`, `installations/<profile>.json` and the staged `cordis.patch.yml` throw on the README's documented `powershell` path — breaking plugin auth, apply plans and theme writes. All records now go through a BOM-free writer (piped and positional call styles both supported).
- **install.ps1 theme file is profile-aware** (P2): `active\web.json` was hard-coded, so a non-`web` profile installation pointed the plugin at a file the Controller never writes. Now `active\<profile>.json`.
- **install.ps1 passes DSH_HOME to the Controller and DSH_SKIN_URL/DATA_DIR to the Codex MCP** (P2): a custom `-DshHome`/`-DataDir` no longer leaves the Controller and MCP client looking at the default directories (target-key mismatch, phantom second Controller instance).
- **install.ps1 `-SkipSkill` refuses the source-checkout runtime** (P3): the patch/MCP entries would point at the repo and break the self-contained install after the source moves; an explicit `-SkipBuild` still allows the dev loop.
- **GC reclaims every terminal transaction** (P2): committed and crash-residue `prepared` transactions older than one day were never pruned; only `failedAt` records were. Now `committedAt`/`failedAt`/`prepared`-createdAt all expire, keeping `dataDir/transactions/` bounded.
- **Preview-stop cleanup failures fail safe** (P2): a cleanup error during `stopWithinWarmLock` no longer strands the session in `stopping` forever; it transitions to `failed-safe` with the reason, and the GC later reaps orphaned runtime dirs (including `%TEMP%\dsh-skin-isolated-<uuid>.dsh` homes that reconcile cannot prove ownership of).
- **MCP asset_upload accepts 4 MiB** (P3): the zod cap matched the Controller's base64 limit instead of the documented 1 MiB.
- **Studio restore no longer requires a live preview** (P3): restore confirmation was gated on the same `canApply` (live preview receipt) as apply; it now only requires capability compatibility.
- **`/api/v1/studio/open` verifies the opener** (P3): `explorer.exe` returning success without a browser association used to report `opened:true` unconditionally; the opener now gets a short grace period and a failed exit code is reported.
- Tests extended (GC transaction states) and the full suite (28) is green; the earlier `Isolated DSH did not expose the managed Host route` failure was a resource-race flake (passes in isolation and in the full run).

## 2026-08-18 — Persistent sidebar divider (host + client)

- The sidebar/main divider is now a persistent stylesheet pseudo-element (`.pI_x6G_sidebarCol::after`, gradient + glow, with the column made `position: relative`), so a conversation switch cannot detach it the way it detached the old DOM decoration. The Client stops painting the divider DOM decoration whenever the persistent base is present (it remains a fallback without the index seam, and the split blend transition is still client-painted).
- Verified with the 7/7 test suite; the DSH process restarts once to serve the new stylesheet.

## 2026-08-18 — Body-background linked canvas (seamless on route switch, host)

- The zero-blur, full-opacity linked backdrop is now painted directly on the body background (`html body { background-image …; background-attachment: fixed }`) instead of an `html body::before` pseudo canvas with `position:fixed; z-index:-1`. A body background sits below every element and cannot be detached, re-ordered, or hidden by a route transition transform/filter — so switching conversations can never blank the backdrop. Blurred/partial-opacity themes keep the pseudo canvas.
- Verified by the updated generation tests (zero-blur → body background; blurred → pseudo canvas); 7/7 pass. The DSH process restarts once to serve the new stylesheet.

## 2026-08-18 — Persistent image overlay parity (host/client)

- Fixed the Host image serializer reading the whole `overlay` object as a color. The persistent canvas now paints the configured overlay before the Client mounts its regional layer, so the sidebar and main area no longer become darker when hydration or a route remount finishes.
- Conversation masking still applies only to the main workspace; the sidebar keeps its configured base appearance.

## 2026-08-18 — Synchronous conversation-mask transitions (client-only)

- Conversation navigation now pins the mask on `pointerdown`, before DSH replaces the route DOM. The verified `data-phase=active` root is authoritative, while a short settling window keeps the mask through transient hero-row mounts.
- The injected CSS is phase-aware and updates when the preview theme changes, so the main workspace does not flash from the normal mask to 70% later, and returning to New Session immediately restores the configured base mask.
- Linked and split layouts both receive the same 70% conversation treatment; split main-image overlays are applied without replacing or re-decoding the image.
- Verified with the real rc.6 isolated-preview browser test and the regional hydration test; the persistent DSH/Profile remains untouched.

## 2026-08-18 — View-state conversation mask (superseded)

- The mask is no longer inferred from the hero row's presence (DSH flashes/rebuilds it during route transitions, which made the hero page darken after a while). It is now keyed on an explicit client-held view state: `html[data-dsh-skin-view="conversation"]` set on conversation-row click (pinned while the route opens) and cleared by the new-session/brand button, with a 400 ms debounced hero-row observer as the non-click fallback.
- This was the initial client-only implementation. The synchronous phase-aware transition above supersedes its lighter 0.4 mask and debounced-only route detection.

## 2026-08-18 — Hero-flash-safe conversation mask (client-only)

- DSH can flash the hero layout (hero workspace row briefly mounted) while a conversation route transitions, and the stylesheet's hero-off rule then dropped the 70% mask mid-switch — matching the observed "switches light, then dark again" flicker. The accelerator no longer uses an inline style (which was lost when the main column was replaced) and never clears on the hero row re-appearing.
- It now keys a client-injected, higher-specificity rule on `html[data-dsh-skin-opening]` (set on conversation-row click, cleared when the hero row is gone or on new-session/brand click). Because the attribute lives on `<html>`, a replaced main column is styled instantly, and the `#root` id makes the override outrank the hero-off rule while the route transition flashes the hero row.
- Verified live: forcing a hero-row flash during a conversation kept the mask at 0.7; the mask still drops to 0 on hero and returns to 0.7 in conversations. Client-only — a hard refresh loads it.

## 2026-08-18 — Render-receipt backoff (console spam fix, client-only)

- The Client previously POSTed `/dsh-skin/rendered` on every 1.2s poll even when the acknowledged theme had not changed. On pages where that ack persistently fails (stale page with an old plugin instance id, host/controller mismatch), DevTools showed a failed fetch every 1.2s ("提取 加载失败" in Chinese Edge = "fetch failed"), growing without bound.
- The receipt is now sent only when the acknowledged signature changes (mode/designId/revision/hash), and failures back off exponentially from 5s to a 30s cap; a signature change retries immediately. Verified live: 7 state polls produced exactly 1 rendered POST, and the first ack still succeeds normally.

## 2026-08-18 — Click-instant conversation mask (no loading pop, client-only)

- DSH can keep the hero layout mounted while a conversation loads, so a stylesheet-only mask (off on hero) still pops on after the route finishes. A client accelerator now closes that window: clicking a conversation/project row applies an inline `background-color: mask !important` to the main column immediately (even while the hero row is still mounted), the stylesheet rule takes over seamlessly once the hero row is gone, and returning to the hero clears the inline. A hero-row removal observer covers every other conversation entry path.
- Client-only change: no DSH restart needed, a hard refresh loads it.

## 2026-08-18 — Phase-independent conversation mask (no loading pop)

- The persistent stylesheet's conversation mask no longer depends on the ConversationRoot `data-phase` attribute. It is now default-on for the main region (`html body .pI_x6G_centerCol { background-color/box-shadow: mask }`) and off only on the hero (`html body:has(div.wSkVaW_heroWorkspaceRow) .pI_x6G_centerCol { transparent/none }`, which outranks the default by specificity).
- This covers route loading windows: while a conversation is mounting there is no hero row, so the mask stays applied instead of popping on after the conversation finishes loading. Verified in a live rc.6 session by forcing the phase to `loading` and by removing the attribute entirely — the mask held at 0.7 in both cases, and dropped to 0 the instant the hero row mounted.
- The Studio background panel does not expose the mask (it is a runtime treatment with no ThemeSpec field); the strength stays 70% as before.

## 2026-08-18 — CSS-owned conversation mask, persistent sidebar treatment, and sidebar balance button

- The conversation 70% mask is now owned entirely by the persistent stylesheet (a live `:has(div.wSkVaW_root[data-phase="active"])` rule). The Client no longer paints an inline `background-color` for the mask while the persistent base is present — an inline `!important` value captured during a stale route phase used to block the stylesheet rule, which made the mask drop to base and then "reload". Inline painting remains only as a fallback when the index seam is unavailable.
- The Client also stops writing inline `background: transparent !important` on the canvas panels while the persistent base is present: that inline value overrode the stylesheet mask and the sidebar transparency on every replaced element. The stylesheet now owns panel transparency; the Client keeps only position/isolation inline treatment.
- The persistent base now pins the sidebar content root with a broader, sidebar-scoped rule (`html body .pI_x6G_sidebarCol .hHd-Xa_root { background: transparent; position: relative; z-index: 1 }`), so a replaced sidebar subtree cannot return to the native opaque panel or slide under the backdrop layer during a conversation switch.
- Local remount retries increased from 3 to 6 with a shorter schedule (24 ms × attempt), so a transition window of ~500 ms is covered before the network polling fallback.
- Added a sidebar 余额 button inside `hHd-Xa_settingsArea` above the native 设置 trigger. It shares the localStorage cache and a `dsh-skin-balance` window event with the composer chip; click forces a refresh; it re-mounts automatically when the sidebar subtree is replaced.
- Verified with 9/9 source/unit tests and a live Chromium session: hero shows no mask, conversation shows the CSS-driven `rgba(0,0,0,0.7)` mask instantly on every switch (no inline blocking), sidebar button and composer chip stay in sync (live CNY balance), skin remains stable. The DSH process restarts once to load the new Host stylesheet rules.

## 2026-08-18 — Persistent skin base (index seam) and always-on balance

- The Host now injects a persistent skin base into every served index.html through the official `webServer.tapIndex` seam (the same seam the built-in ui-theme uses for its boot theme). The current theme is pinned at the CSS level on `html body` (`::before` canvas, per-panel transparency, conversation mask via `:has`, optional sidebar divider), so DSH route transitions — which replace React subtrees but never the body — cannot blank or reload the background. The Client layers remain the refinement layer; the base is painted from the very first request (synchronous theme-file fallback before the first preview poll).
- The composer balance chip is now always visible: it mounts on the detail dock in conversation views and on the composer trailing row on the hero, moves between hosts automatically, and persists its value in localStorage so a reload paints the balance immediately (the Host route remains the 30s-cached source of truth; click/Enter/Space forces a refresh).
- Verified with unit/source-contract tests and a live Chromium session: hero chip in the trailing row, dock chip in the conversation detail row, live balance (CNY), skin stable across hero↔conversation switches. The DSH process restarts once to load the new Host seam.

## 2026-08-18 — Conversation-switch skin hardening and composer-dock balance

- The client's regional geometry tolerance now grows with the device pixel ratio (was a fixed 1 CSS px), so scaled displays/remote-desktop compositing can no longer permanently fail region discovery after a route switch.
- The layout observer now also treats removal of any skin-owned target or layer as a regional change, and a failed rebind rebuilds the backdrop immediately from the acknowledged in-memory snapshot instead of waiting for the network polling round; the 1.2s poll remains the final fallback.
- Added a composer-dock balance chip (`div.FJxK0a_root` inside the `conversation.composer.dock` slot): it queries the same-origin Host route, re-appends itself after every dock re-render, and click/Enter/Space forces a refresh.
- The Host now exposes `/dsh-skin/balance` (loopback-only): the DeepSeek API key resolves from `DSH_SKIN_BALANCE_API_KEY`, `DEEPSEEK_API_KEY`, or `%DSH_HOME%/.credentials.yaml`, never leaves the Host, and responses are cached 30s (`refresh=1` bypasses). Verified against the real DeepSeek balance endpoint (CNY, live total).
- Verified with the source-contract/unit tests and a live Chromium session: stable skin across hero↔conversation switches and chip mount/re-mount. The DSH process restarts once to load the new Host routes.

## 2026-08-18 — Controller data-directory garbage collection

- The Controller now runs a bounded garbage collector on startup and hourly: expired browser sessions and confirmations, terminal operations/transactions/patches older than 24 hours, and terminal isolated-preview records together with their runtime directories and cleanup records.
- The append-only operations journal rotates into timestamped archives above 1 MiB (newest three kept); rotation runs only in the startup pass so a concurrent append can never race it.
- Durable state (`active/`, `applied-designs/`, `restore-state/`, `installations/`, `plugin-secrets/`, `designs/`, `assets/`) is never touched.
- Added a store-level regression test covering pruning rules and journal rotation. Verified with the new GC test and a clean Controller build.

## 2026-08-18 — Native Skin Studio settings entry and route-safe remounts

- The managed DSH plugin now composes the native Plugins settings package and registers a **皮肤设置** card with a one-click **启动并打开 Skin Studio** action. The action stays same-origin on the DSH Host and redirects only to the validated loopback Controller URL.
- Client regional hydration now treats replaced sidebar/main/composite targets and removed skin-owned layers as disconnected, observes route phase/class replacement, and remounts the last acknowledged theme immediately. This prevents the skin from disappearing when switching conversations.
- The source static contracts and plugin build pass; the persistent DSH/Profile remain untouched until the user explicitly confirms a managed plugin update.

## 2026-08-18 — First-click confirmation recovery and settings portal layering

- The first **写入我的 DSH** click now waits for or renews the current isolated render receipt, retries one stale-receipt conflict, and keeps the returned safety plan stable when duplicate live-preview events arrive. The dialog no longer shows a false stale-preview error while the first plan request is still loading.
- The managed rc.6 Client promotes the verified sidebar stacking context above the main composer so native DSH settings portals remain clickable after the skin is installed. The override is reversible on layout rebind and plugin disposal.
- Verified with a real Studio browser session (first apply-plan response 200, no error panel after 8 seconds), a real isolated rc.6 iframe (sidebar `z-index: 2147483645`), and the full 21-test suite. The user's DSH/Profile were not modified.

## 2026-08-18 — Confirmation session recovery and renewal-safe apply

- Same-origin Studio `GET` requests now refresh a missing or expired browser session cookie, while isolated Host/plugin routes remain excluded. A restored Studio tab can therefore reach the confirmation endpoint without being rejected as an invisible/nonexistent browser session.
- The write affordance now reserves the full warm-preview renewal window. Automatic receipt renewal cannot race the first plan click; if the current receipt is too close to expiry, the button remains unavailable until the replacement preview is live.
- The agent client now treats `doctor`/`studio_status` as the recovery handshake after a Controller restart and adopts the current instance; mutation requests still re-check instance identity immediately before writing.
- Verified with controller/studio/agent-cli typechecks, production build, 19 regression tests, a fresh portable runtime, an API GET cookie-recovery check, direct bundled-agent doctor, and a newly started visible Studio. The user's DSH/Profile were not modified.

## 2026-08-18 — Persistent canvas and first-write stability gate

- The Client now keeps one acknowledged backdrop canvas on the verified rc.6 split-layout root. Route and conversation hydration replacements rebind the existing image/colour layers instead of disposing them, re-fetching state, or waiting for the polling fallback; image fit, position, and decoded pixels remain continuous while switching conversations.
- Independent sidebar and main image layers still use their own derived surfaces and position controls, while the shared composite host prevents visible background reloads during DOM replacement.
- Studio no longer exposes or submits **写入我的 DSH** while a preview debounce, in-flight update, or queued update is pending. It rechecks the live session/generation/receipt immediately before planning and again before confirmation, eliminating the first-click stale-plan race; a fresh live receipt is required after a real edit.
- Verified with source typechecks/build, a real isolated rc.6 Chromium preview, persistent layer hydration, image fit/position updates, and the full 18-test suite (18/18 passed). The user's DSH and Profile were not modified.

## 2026-08-18 — Responsive context-conversation background

- Replaced the context-conversation route remount with an in-memory, already acknowledged ThemeSpec rebuild. Changing between conversations no longer fetches `/dsh-skin/state`, waits for a render receipt, or asks the browser to reload the same immutable background asset.
- Kept the 1.2-second state poll strictly as an update/recovery channel, including after a local remount, so a new Studio edit still reaches the preview without delaying route changes.
- In independent-region mode, the main workspace's required 70% conversation mask is now a reversible, zero-blur inset overlay on the existing backdrop layer. Its `background-image`, image position, fit, and decoded pixels remain unchanged.
- Removed the no-op `blur(0px)` compositing filter and contained backdrop painting, reducing GPU work during large contextual conversation switches.
- Verified by a real isolated rc.6 Chromium session and the full suite: 17/17 passed. The regression asserts that a remount emits no `/dsh-skin/state` request and that the main image remains unchanged while the 70% mask is applied.

## 2026-08-18 — Fast background remount on session switch

- Replaced the visible one-to-1.2-second session-switch delay with a capability-pinned rc.6 layout observer. When DSH replaces the sidebar, frame, workspace root, hero row, or verified sidebar content surface, the Client coalesces the change for 48 ms and remounts the existing backdrop immediately.
- Ordinary message-stream DOM updates are ignored. The 1.2-second state poll remains only as a low-frequency recovery fallback, and concurrent refreshes are coalesced rather than aborted/restarted repeatedly.
- Verified in a real isolated rc.6 Chromium runtime by replacing a capability-pinned hydrated sidebar surface: the old backdrop was disposed and a new one mounted in under 900 ms, ahead of the polling fallback. Full suite: 17/17 passed.

## 2026-08-18 — Fractional rc.6 split-layout geometry repair

- Fixed the remaining real-DHS render blocker after a successful injection. In the observed desktop rc.6 layout, the split root's right edge was smaller than its main child by about `0.00006` CSS px due to compositing; an exact comparison incorrectly put the Client into safe degraded mode with no backdrop layer.
- Regional discovery now permits at most one CSS pixel of rasterization difference when proving that the verified composite root spans its sidebar and main children. A larger geometry gap remains fail-closed, so this does not broaden selection to unrelated layouts.
- Verified against the actual user-page DOM evidence, targeted real isolated Chromium rendering, and a full 16-test suite. The rebuilt Skill runtime is available through the local Studio; a fresh visible confirmation is still required before the updated client package is written to the user DSH.

## 2026-08-18 — Active-conversation render and managed plugin update repair

- Fixed the real DSH failure that left the page black after a restart: the rc.6 Client previously required the New Session-only `wSkVaW_heroWorkspaceRow`. It now keeps that strict capability check and falls back only to the separately verified unique `wSkVaW_root` used by an opened conversation.
- A visible **确认并写入我的 DSH** operation now stages the current managed plugin package as well as the theme. The immutable plan binds that action to the same isolated live-render receipt and human confirmation; agents default to that safe package-update plan unless they explicitly request a theme-only plan.
- The confirmation dialog explicitly says **已安装，将更新插件和主题**, so an already-installed but older client cannot silently remain in place after an approved update.
- Rebuilt the portable Skill runtime and restarted only its local Controller. The user's DSH process and Profile were not edited during this repair; the next persistent update still requires a fresh visible confirmation in Studio.
- Verified with the Controller self-check, an isolated real rc.6 Chromium preview, the New Session/opened-conversation capability selector contract, a cold Skill install, and the full 15-test suite.

## 2026-08-18 — Reliable confirmation after live preview

- Fixed a Studio timing race where the **写入我的 DSH** button could become visible just before an internal stale eligibility flag updated, causing a current `live` isolated-preview receipt to be rejected as expired.
- Apply planning and confirmation now authenticate directly against the current design/session/generation/render receipt at click time. Duplicate real-time events no longer invalidate an already displayed plan; a genuine revision, generation, hash, or receipt change still invalidates it immediately.
- Corrected the Controller plan response to echo the same canonical `previewSessionId`, `previewGeneration`, and `renderReceiptHash` fields used by the Studio and confirm endpoint. A valid current plan is no longer rejected because of a field-name mismatch.
- A receipt is now pinned for each live preview generation: opening another Studio tab or reloading an unchanged isolated iframe no longer rotates the receipt and cancels an otherwise safe apply plan. A real theme update still clears the receipt and requires a fresh preview.
- The rc.6 client now remounts its regional backdrop after late layout hydration replaces a target DOM node. The first preview can therefore reach a real render acknowledgement instead of remaining degraded with an invalid safety plan.
- The confirmation dialog now offers **重新生成安全计划** after a stale-preview error. Once the current isolated preview is `live`, it retries only plan generation in place; it never writes to DSH or bypasses the visible human confirmation.
- Verified with the current local r232 isolated live receipt: the Controller generated a bound immutable plan and the visible Studio confirmation checkbox became enabled without writing the user's DSH; the final write button remained disabled until human acknowledgement. The full 13-test suite also passed.

## 2026-08-18 — Split main-image fit and position preservation

- Fixed the split-mode active-conversation mask so it changes only the image layer's `background-image`. It no longer applies the `background` shorthand that resets the selected image's fit, position, and no-repeat settings.
- With **整合两区域** turned off, the main workspace now keeps its configured `cover` / `contain` / `fill` mode and X/Y position through both New Session and active-conversation phases. The sidebar remains independent.
- Verified in a real isolated DSH rc.6 Chromium preview: the main layer fills the derived workspace surface, starts at 50%/50%, and updates to 7%/93% through the Controller theme path; all 13 tests passed. The user's DSH was not modified.

## 2026-08-18 — Conversation-aware main-workspace mask

- Added a capability-pinned rc.6 ConversationRoot phase observer. Opening an active project conversation raises only the main-workspace background mask to 70%; the sidebar retains its configured backdrop and mask strength.
- Returning to the `hero` New Session page restores the exact configured main-region backdrop. The treatment is runtime-only and does not add a ThemeSpec field or change saved themes.
- Verified in a real isolated rc.6 Chromium page across `hero → active → hero`, including 70% main-mask rendering and sidebar non-mutation, plus the full 13-test suite. The user's DSH was not modified.

## 2026-08-18 — Passive linked hover in the real DSH preview

- Linked-region hover is now independent of the **选择区域** switch. When selection is ended, a capture-phase pointer tracker still paints the unified blue dashed frame as the cursor moves across either region.
- The passive frame remains `pointer-events: none`; the real DSH page, including its onboarding mask and controls, continues to receive normal pointer input. Turning **选择区域** back on clears passive feedback and restores the click/keyboard selector.
- Verified with a real Controller-provisioned DSH rc.6 Chromium iframe after ending selection, including the onboarding mask path, plus the full 13-test suite. The user's DSH was not modified.

## 2026-08-18 — Image-safe sidebar content and linked hover fallback

- Lifted the capability-pinned rc.6 sidebar content root above its structured image backdrop, preserving the logo, labels, controls, and settings action when **整合两区域** is off and the sidebar uses its own image.
- Retained independent sidebar/main image assets in split mode: each region can select, upload, position, and render a different local image.
- Added a non-intercepting Studio-level blue dashed frame for linked-preview hover. It spans the whole merged canvas and remains visible even while the iframe bridge is awaiting a render cycle.
- Verified with the real isolated DSH rc.6 Chromium scenario and the full 13-test suite. The user's DSH was not modified.

## 2026-08-18 — Seamless regional cleanup and linked selection frame

- Neutralized the capability-pinned rc.6 workspace-list bottom fade (`qDHVXG_fade`) whenever it is present, removing the native black gradient above **设置** without changing normal DSH content or controls.
- Reworked the unchecked split boundary into an opaque 72px structured colour cross-fade. It now has no blur, alpha glow, or residual native border; image pairs keep a neutral invisible boundary because there is no safe pixel sample to fabricate between separate crops.
- In **整合两区域** mode, the iframe picker now exposes one blue dashed, lightly tinted frame spanning both regions. It remains keyboard-operable and is independent of the two-region split picker.
- Verified in a real isolated DSH rc.6 Chromium preview: native fade cleanup, linked/split rendering, file upload preservation, the linked hover/click/keyboard bridge, revision handoff, and render receipt checks. The user's DSH was not modified.

## 2026-08-18 — Configurable regional boundary

- Added the persisted **增加分隔线** switch beside **整合两区域**. It is a structured `appearance.regions.divider` setting; existing themes default to off.
- Linked mode keeps exactly one continuous backdrop. Enabling the switch adds only a measured 1px visual overlay at the sidebar boundary; disabling it restores the completely seamless canvas.
- Split mode enables the same managed divider when checked. When unchecked, it replaces the hard boundary with a bounded soft transition band derived from the two structured regional colors/overlays.
- Verified in a real isolated DSH rc.6 Chromium preview across all four linked/split and divider on/off combinations, including Studio checkbox interaction and resizing. The user's DSH was not modified.

## 2026-08-18 — Linked canvas visibility and image import repair

- Cleared the capability-pinned opaque rc.6 sidebar content surface (`hHd-Xa_root hHd-Xa_quietBars`) in both linked and split rendering. Sidebar colors and images are now visible instead of being hidden by the native dark panel.
- In **整合两区域** mode, also suppress the sidebar-only split border while retaining it in independent mode, so the shared canvas has no artificial middle seam.
- Raised the bounded local image ceiling from 720 KiB to 4 MiB and the dedicated asset request ceiling from 1 MiB to 6 MiB. The isolated DSH Host uses the same 4 MiB serving limit.
- Added a real Studio file-picker regression test using a JPEG larger than the previous limit, confirming upload, Controller storage, isolated Host serving, and linked DSH rendering. The Studio now shows the 4 MB limit and reports a local-service error instead of a raw `Failed to fetch` when it cannot connect.

## 2026-08-18 — Unified linked canvas

- Changed **整合两区域** from two synchronized regional layers into one real background canvas mounted on the rc.6 split-layout root. Gradients and uploaded images now span the sidebar and main workspace continuously, without two independent `cover` calculations at the boundary.
- Kept unlinked mode unchanged: sidebar and main can still use independent colors or image assets.
- The shared layer follows the common root's live bounds, so window resizing retains one continuous image rather than producing per-region crops.
- Verified against a Controller-provisioned DeepSeek Harness rc.6 Chromium preview: one linked layer spans both surfaces, split image layers stay independent when unlinked, and the shared layer remains singular and root-aligned after viewport resizing. The user's DSH was not modified.

## 2026-08-18 — Visible dual-region backgrounds

- Fixed image backgrounds that were fetched successfully but hidden behind opaque DSH surfaces by installing the rendered image inside the actual rc.6 sidebar and main workspace containers.
- Added canonical ThemeSpec v2 regional backgrounds with automatic v1 migration, independent sidebar/main editing, and the **整合两区域** mode for synchronized later changes.
- Added an isolated-preview-only region picker: direct hover shows a blue dashed outline; click, Enter, or Space selects the region; the preview toolbar bridge synchronizes the linked mode with Studio without writing the user DSH.
- Verified with real Chromium and a Controller-provisioned DSH rc.6: independent high-contrast images, linked updates, image requests, real input events, exact receipts, and stale-receipt rejection.

## 2026-08-17 — Low-load warm isolated preview

- Replaced one-isolated-DSH-per-edit previewing with one global warm isolated runner.
- Coalesced rapid theme changes (Controller 180 ms; Studio 220 ms) and reused the same preview session while advancing its generation.
- Added an instant Studio draft canvas while retaining a separately verified isolated-DSH preview and exact render-receipt gate before persistent injection.
- Hardened startup, acknowledgement, update-failure, expiry, and cleanup races so stale state or stale receipts cannot authorize a persistent write.
- Verified with 12 automated tests, including actual Chromium/DSH rc.6 isolated rendering. The user's DSH Profile was not edited or restarted.
