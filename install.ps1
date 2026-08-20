# DeepSeek Harness Skin Studio - one-shot installer (ASCII only).
#
# Installs everything the Skill needs into a DeepSeek Harness web profile:
#   1. the Skill bundle itself (%DSH_HOME%/skills/deepseek-harness-skin-studio)
#   2. the managed @dsh-skin/dsh-plugin (skin renderer + native settings card)
#   3. the MCP server registration (mcp__skin-studio__* tools for the model)
#   4. the portable Studio runtime (Controller + Studio UI)
#   5. optionally the Codex skill + MCP registration
#
# Idempotent: re-running it upgrades in place. DSH restart is left to the
# user (or -RestartDsh) so this script never kills a live host silently.
[CmdletBinding()]
param(
  [string]$DshHome,
  [string]$ProfileName = "web",
  [string]$DataDir,
  [int]$ControllerPort = 11862,
  [string]$CodexHome = (Join-Path $env:USERPROFILE ".codex"),
  [switch]$SkipBuild,
  [switch]$SkipSkill,
  [switch]$SkipStudio,
  [switch]$SkipCodexMcp,
  [switch]$RestartDsh
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot ".")).Path
$skillRoot = Join-Path $projectRoot "agents\codex-skill\deepseek-harness-skin-studio"
if (-not (Test-Path -LiteralPath (Join-Path $skillRoot "SKILL.md") -PathType Leaf)) {
  throw "Skill folder not found: $skillRoot"
}
if ([string]::IsNullOrWhiteSpace($DshHome)) { $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" } }
$DshHome = [IO.Path]::GetFullPath($DshHome)
if ([string]::IsNullOrWhiteSpace($DataDir)) { $DataDir = Join-Path $env:LOCALAPPDATA "DeepSeekHarnessSkinStudio" }
$DataDir = [IO.Path]::GetFullPath($DataDir)

# PowerShell 5.1's Set-Content -Encoding UTF8 writes a BOM, which breaks the
# Controller's JSON.parse of every record file it reads. Always write UTF-8
# without a BOM so the installer works identically under powershell.exe (5.1)
# and pwsh (7+). Both call styles must work: `... | Set-Utf8NoBom $path`
# (piped text) and `Set-Utf8NoBom $path $text` (positional).
function Set-Utf8NoBom {
  param(
    [Parameter(Mandatory = $true, Position = 0)][string]$Path,
    [Parameter(Mandatory = $true, Position = 1, ValueFromPipeline = $true)][AllowEmptyString()][string]$Text
  )
  process { [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false))) }
}

# --- 0. portable runtime -----------------------------------------------------
$runtime = Join-Path $skillRoot "runtime"
$runtimeReady = (Test-Path -LiteralPath (Join-Path $runtime "node_modules\@dsh-skin\controller\dist\index.js") -PathType Leaf) -and
  (Test-Path -LiteralPath (Join-Path $runtime "node_modules\@dsh-skin\mcp-server\dist\index.js") -PathType Leaf) -and
  (Test-Path -LiteralPath (Join-Path $runtime "plugin\dist\host\index.js") -PathType Leaf)
if (-not $runtimeReady) {
  if ($SkipBuild) { throw "Portable runtime is missing and -SkipBuild was given." }
  Write-Host "[install] building portable runtime..." -ForegroundColor Cyan
  & (Join-Path $skillRoot "scripts\build-portable.ps1") -ProjectRoot $projectRoot -OutputPath $runtime | Out-Null
}

# --- 1. DSH paths -----------------------------------------------------------
$profileDir = Join-Path $DshHome "profiles\$ProfileName"
$profilesNodeModules = Join-Path $DshHome "profiles\node_modules\@dsh-skin"
$pluginTarget = Join-Path $profilesNodeModules "dsh-plugin"
$patchPath = Join-Path $profileDir "cordis.patch.yml"
$skillTarget = Join-Path $DshHome "skills\deepseek-harness-skin-studio"
$themeFile = Join-Path $DataDir "active\$ProfileName.json"
$assetDir = Join-Path $DataDir "assets\content"
$controllerUrl = "http://127.0.0.1:$ControllerPort"
$nodePath = (Get-Command node -ErrorAction Stop).Source

# --- 2. helper: hash --------------------------------------------------------
function Get-Sha256([string]$Text) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($bytes)).Replace("-", "")).ToLower() } finally { $sha.Dispose() }
}

# --- 3. plugin secret (reuse existing when present) --------------------------
$secretRecordPath = Join-Path $DataDir "plugin-secrets\$ProfileName.json"
$secret = $null
if (Test-Path -LiteralPath $secretRecordPath) {
  try { $secret = (Get-Content -Raw -LiteralPath $secretRecordPath | ConvertFrom-Json).secret } catch {}
}
if ([string]::IsNullOrWhiteSpace($secret)) {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $secret = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

# --- 4. install skill bundle first: the installed bundle is the single ------
# source for the MCP entry, the controller entry and the plugin package, so
# the whole installation is self-contained under %DSH_HOME%.
if (-not $SkipSkill) {
  if (Test-Path -LiteralPath $skillTarget) { Remove-Item -LiteralPath $skillTarget -Recurse -Force }
  New-Item -ItemType Directory -Path (Join-Path $DshHome "skills") -Force | Out-Null
  Copy-Item -LiteralPath $skillRoot -Destination $skillTarget -Recurse
  @{
    schemaVersion = 1
    runtimeRoot = "runtime"
    controllerUrl = $controllerUrl
    installedAt = (Get-Date).ToUniversalTime().ToString("o")
  } | ConvertTo-Json | Set-Utf8NoBom (Join-Path $skillTarget "runtime.local.json")
  $runtime = Join-Path $skillTarget "runtime"
}
$controllerEntry = Join-Path $runtime "node_modules\@dsh-skin\controller\dist\index.js"
$mcpEntry = Join-Path $runtime "node_modules\@dsh-skin\mcp-server\dist\index.js"
$pluginSource = Join-Path $runtime "plugin"
# -SkipSkill keeps the source-checkout runtime only when that runtime is
# actually the installed one; otherwise the patch/MCP entries would point at
# the checkout and break the self-contained contract after the source moves.
if ($SkipSkill -and -not $SkipBuild) {
  $resolvedRuntime = (Resolve-Path -LiteralPath $runtime -ErrorAction SilentlyContinue).Path
  $dshHomePrefix = (Resolve-Path -LiteralPath $DshHome).Path.TrimEnd('\') + '\'
  if ([string]::IsNullOrWhiteSpace($resolvedRuntime) -or -not $resolvedRuntime.StartsWith($dshHomePrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "-SkipSkill requires an installed portable runtime under $DshHome (run a full install once); the source checkout runtime would break the self-contained install."
  }
}

# --- 5. write cordis.patch.yml (idempotent) ---------------------------------
New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
$patchText = ""
if (Test-Path -LiteralPath $patchPath) {
  $patchText = (Get-Content -Raw -LiteralPath $patchPath) -replace '(?ms)\r?\n?# >>> dsh-skin-studio.*?# <<< dsh-skin-studio[^\r\n]*\r?\n?', ""
  $patchText = $patchText.TrimEnd() + "`n"
}
$managedBlock = (@(
  "# >>> dsh-skin-studio managed block >>>",
  "- insert:",
  "    - id: dsh-skin-studio",
  "      name: '@dsh-skin/dsh-plugin'",
  "      config:",
  "        profile: '$ProfileName'",
  "        themeFile: '$themeFile'",
  "        assetDir: '$assetDir'",
  "        controllerUrl: '$controllerUrl'",
  "        controllerEntry: '$controllerEntry'",
  "        dataDir: '$DataDir'",
  "        pluginSecret: '$secret'",
  "# <<< dsh-skin-studio managed block <<<"
) -join "`n")
$mcpBlock = (@(
  "# >>> dsh-skin-studio MCP server >>>",
  "- insert:",
  "    - id: mcp-skin-studio",
  "      name: '@deepseek-ai/dsh-mcp-client'",
  "      config:",
  "        serverName: skin-studio",
  "        transport: stdio",
  "        command: '$nodePath'",
  "        args:",
  "          - '$mcpEntry'",
  "        env:",
  "          DSH_SKIN_URL: '$controllerUrl'",
  "          DSH_SKIN_CONTROLLER_ENTRY: '$controllerEntry'",
  "# <<< dsh-skin-studio MCP server <<<"
) -join "`n")
$nextPatch = ($patchText.TrimEnd() + "`n`n" + $managedBlock + "`n" + $mcpBlock + "`n")
$stage = Join-Path $profileDir ".cordis.patch.stage"
Set-Utf8NoBom $stage $nextPatch
Move-Item -LiteralPath $stage -Destination $patchPath -Force

# --- 6. install plugin package ----------------------------------------------
New-Item -ItemType Directory -Path $profilesNodeModules -Force | Out-Null
if (Test-Path -LiteralPath $pluginTarget) { Remove-Item -LiteralPath $pluginTarget -Recurse -Force }
Copy-Item -LiteralPath $pluginSource -Destination $pluginTarget -Recurse

# --- 7. controller-managed records ------------------------------------------
New-Item -ItemType Directory -Path (Join-Path $DataDir "plugin-secrets") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $DataDir "installations") -Force | Out-Null
# Match the Controller's canonical target key: sha256(stableStringify({dshHome, profile})).
# Use an ordered hashtable: ConvertTo-Json serializes [ordered]@{} in declaration
# order, which matches the Controller's sorted-key stableStringify for this
# two-key object on every PowerShell version.
$targetKey = Get-Sha256 (([ordered]@{ dshHome = (Resolve-Path -LiteralPath $DshHome).Path.ToLower(); profile = $ProfileName } | ConvertTo-Json -Compress))
$secretHash = Get-Sha256 $secret
$managedHash = Get-Sha256 $managedBlock
@{ targetKey = $targetKey; secret = $secret; secretHash = $secretHash; createdAt = (Get-Date).ToUniversalTime().ToString("o") } |
  ConvertTo-Json | Set-Utf8NoBom $secretRecordPath
@{ targetKey = $targetKey; profile = $ProfileName; themePath = $themeFile; assetDir = $assetDir; managedBlockHash = $managedHash; installedAt = (Get-Date).ToUniversalTime().ToString("o") } |
  ConvertTo-Json | Set-Utf8NoBom (Join-Path $DataDir "installations\$ProfileName.json")

# --- 8. start Studio (Controller) -------------------------------------------
$studioState = "not-started"
if (-not $SkipStudio) {
  try {
    $probe = Invoke-RestMethod -Uri "$controllerUrl/api/v1/status" -TimeoutSec 3
    if ($probe.ok) { $studioState = "already-running" }
  } catch {}
  if ($studioState -eq "not-started") {
    $controllerLog = Join-Path $env:TEMP "dsh-skin-controller.out.log"
    $controllerErr = Join-Path $env:TEMP "dsh-skin-controller.err.log"
    $env:DSH_SKIN_PORT = "$ControllerPort"
    $env:DSH_SKIN_DATA_DIR = $DataDir
    $env:DSH_HOME = $DshHome
    Start-Process -FilePath $nodePath -ArgumentList @($controllerEntry) `
      -WorkingDirectory $runtime -WindowStyle Hidden -RedirectStandardOutput $controllerLog -RedirectStandardError $controllerErr | Out-Null
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline) {
      try { $probe = Invoke-RestMethod -Uri "$controllerUrl/api/v1/status" -TimeoutSec 2; if ($probe.ok) { $studioState = "started"; break } } catch {}
      Start-Sleep -Milliseconds 400
    }
    if ($studioState -eq "not-started") { $studioState = "start-failed (see $controllerErr)" }
  }
}

# --- 9. optional Codex registration ------------------------------------------
$codexState = "not-configured"
if (-not $SkipCodexMcp) {
  $codex = Get-Command codex -ErrorAction SilentlyContinue
  if ($codex) {
    $codexSkillTarget = Join-Path $CodexHome "skills\deepseek-harness-skin-studio"
    if (Test-Path -LiteralPath $codexSkillTarget) { Remove-Item -LiteralPath $codexSkillTarget -Recurse -Force }
    New-Item -ItemType Directory -Path (Join-Path $CodexHome "skills") -Force | Out-Null
    Copy-Item -LiteralPath $skillRoot -Destination $codexSkillTarget -Recurse
    & $codex.Source mcp get deepseek-harness-skin-studio *> $null
    if ($LASTEXITCODE -ne 0) {
      & $codex.Source mcp add deepseek-harness-skin-studio --env "DSH_SKIN_CONTROLLER_ENTRY=$controllerEntry" --env "DSH_SKIN_PLUGIN_SOURCE=$pluginSource" --env "DSH_SKIN_URL=$controllerUrl" --env "DSH_SKIN_DATA_DIR=$DataDir" -- $nodePath $mcpEntry
      if ($LASTEXITCODE -eq 0) { $codexState = "registered" } else { $codexState = "codex-mcp-add-failed" }
    } else { $codexState = "already-registered" }
  }
}

# --- 10. DSH restart (opt-in) ------------------------------------------------
$restartState = if ($RestartDsh) { "requested (run restart manually or open the desktop launcher)" } else { "not-requested" }

[ordered]@{
  ok = $true
  dshHome = $DshHome
  profile = $ProfileName
  patch = $patchPath
  plugin = $pluginTarget
  skill = if ($SkipSkill) { $null } else { $skillTarget }
  mcpServerName = "skin-studio"
  controllerUrl = $controllerUrl
  studio = $studioState
  codex = $codexState
  restart = $restartState
  note = "Restart the DeepSeek Harness web process so the profile patch and MCP client load; then ask the model to design a skin (it will call mcp__skin-studio__* automatically)."
} | ConvertTo-Json -Depth 4
