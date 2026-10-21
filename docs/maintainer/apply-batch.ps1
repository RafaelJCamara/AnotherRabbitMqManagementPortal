#Requires -Version 7
<#
.SYNOPSIS
  Applies the human-only (protected-path) changes prepared in docs/maintainer/BATCH.md.

.DESCRIPTION
  Edits three protected files, each step idempotent (re-running changes nothing and says so):

    1. pnpm-workspace.yaml   `overrides:` entry  'vite@8.3.0': 8.3.4   (osv-scanner: vite GHSA-587h-7wmj-h5pm,
                             GHSA-698v-4r3x-3vcv, GHSA-r825-w8mm-5pxw; fixed in 8.3.3, 8.3.4 is 13 days old)
    2. docs/adr/ADR-027-log.md   one row in a new "Overrides" section recording that override
    3. CODEOWNERS            the trust-critical lines recorded in docs/open-questions.md
                             (OQ-86, OQ-107, OQ-178, OQ-429, OQ-492, OQ-633), plus the project paths that
                             carry the trust:critical tag but have no line yet when -IncludeTagDerived is set

  Every anchor is verified before anything is written; if one is missing the script stops without
  touching that file. Then it runs `pnpm install` (never a hand-edited lockfile) and
  `pnpm nx run supply-chain:gates`, and checks the lockfile no longer resolves vite 8.3.0.

  It never commits. The git commands are at the end of docs/maintainer/BATCH.md.

.PARAMETER Root
  Repository root. Defaults to two levels above this script. Point it at a scratch copy to rehearse.

.PARAMETER SkipInstall
  Do not run `pnpm install`.

.PARAMETER SkipGates
  Do not run `pnpm nx run supply-chain:gates`.

.PARAMETER IncludeTagDerived
  Also add CODEOWNERS lines for projects tagged trust:critical that no open question proposed
  (adapter-amqp091, jobs, svc-ops, ui/design).

.PARAMETER WhatIf
  Dry run: print every change that would be made, write nothing, run nothing.

.EXAMPLE
  pwsh docs/maintainer/apply-batch.ps1 -WhatIf
  pwsh docs/maintainer/apply-batch.ps1
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [string]$Root = (Join-Path $PSScriptRoot '..' '..'),
  [switch]$SkipInstall,
  [switch]$SkipGates,
  [switch]$IncludeTagDerived
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath $Root).Path
$script:Changes = 0

# ---- helpers ---------------------------------------------------------------------------------

function Read-Lines([string]$Path) {
  # Returns @{ Lines = [string[]] (no trailing empty element); Nl = "`n" or "`r`n"; Final = bool }
  $text = [IO.File]::ReadAllText($Path)
  $nl = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
  $final = $text.EndsWith("`n")
  $lines = [System.Collections.Generic.List[string]]::new()
  foreach ($l in ($text -split '\r?\n')) { $lines.Add($l) }
  if ($final) { $lines.RemoveAt($lines.Count - 1) }
  return @{ Lines = $lines; Nl = $nl; Final = $final }
}

function Save-Lines([string]$Path, $Doc) {
  $text = ($Doc.Lines -join $Doc.Nl)
  if ($Doc.Final) { $text += $Doc.Nl }
  if ($PSCmdlet.ShouldProcess($Path, 'write')) {
    [IO.File]::WriteAllText($Path, $text, [Text.UTF8Encoding]::new($false))
  }
}

function Say([string]$Message) { Write-Host $Message }

function Find-Anchor([System.Collections.Generic.List[string]]$Lines, [string]$Pattern, [string]$What) {
  for ($i = 0; $i -lt $Lines.Count; $i++) { if ($Lines[$i] -match $Pattern) { return $i } }
  throw "Anchor not found ($What): /$Pattern/. The file changed shape; nothing was written to it."
}

function Find-AllLines([System.Collections.Generic.List[string]]$Lines, [string]$Pattern) {
  $hits = @()
  for ($i = 0; $i -lt $Lines.Count; $i++) { if ($Lines[$i] -match $Pattern) { $hits += $i } }
  return , $hits
}

# ---- 1. pnpm-workspace.yaml: overrides -------------------------------------------------------

$OverrideKey = 'vite@8.3.0'
$OverrideValue = '8.3.4'

function Update-Workspace([string]$Path) {
  Say "[1/3] $Path"
  $doc = Read-Lines $Path
  $lines = $doc.Lines
  $entry = "  '$OverrideKey': $OverrideValue"
  $keyPattern = "^\s+['""]?$([regex]::Escape($OverrideKey))['""]?\s*:"

  $overridesAt = Find-AllLines $lines '^overrides\s*:'
  if ($overridesAt.Count -gt 1) { throw "pnpm-workspace.yaml has $($overridesAt.Count) top-level 'overrides:' keys; fix by hand." }

  if ($overridesAt.Count -eq 1) {
    $start = $overridesAt[0]
    $end = $start + 1
    # The block ends at the first non-blank line that starts in column 0.
    while ($end -lt $lines.Count -and ($lines[$end] -match '^\s' -or $lines[$end].Trim() -eq '')) { $end++ }
    $existing = @(); for ($i = $start + 1; $i -lt $end; $i++) { if ($lines[$i] -match $keyPattern) { $existing += $i } }
    if ($existing.Count -gt 1) { throw "overrides: '$OverrideKey' appears $($existing.Count) times; fix by hand." }
    if ($existing.Count -eq 1) {
      if ($lines[$existing[0]] -match ":\s*['""]?$([regex]::Escape($OverrideValue))['""]?\s*(#.*)?$") {
        Say "  already applied: overrides '$OverrideKey' -> $OverrideValue (no change)"
        return
      }
      throw "overrides already has '$OverrideKey' with a different value ($($lines[$existing[0]].Trim())). Decide by hand."
    }
    $lines.Insert($start + 1, $entry)
    Say "  + overrides: $($entry.Trim())   (added to the existing overrides block)"
  }
  else {
    $anchor = Find-Anchor $lines '^strictDepBuilds\s*:' "pnpm-workspace.yaml 'strictDepBuilds'"
    $block = @(
      '',
      '# Security lane (docs/runbooks/security-lane.md): @angular/build pins vite 8.3.0, which bundles launch-editor with',
      '# GHSA-587h-7wmj-h5pm, GHSA-698v-4r3x-3vcv and GHSA-r825-w8mm-5pxw (fixed in vite 8.3.3). Exact versions only; logged in',
      '# docs/adr/ADR-027-log.md. Remove this entry once @angular/build resolves vite >= 8.3.3 on its own.',
      'overrides:',
      $entry
    )
    $lines.InsertRange($anchor + 1, [string[]]$block)
    Say "  + overrides: $($entry.Trim())   (new block after strictDepBuilds)"
  }
  $script:Changes++
  Save-Lines $Path $doc
}

# ---- 2. ADR-027 log: overrides row -----------------------------------------------------------

function Update-AdrLog([string]$Path) {
  Say "[2/3] $Path"
  $doc = Read-Lines $Path
  $lines = $doc.Lines
  $already = Find-AllLines $lines ('^\|.*`overrides`.*`' + [regex]::Escape($OverrideKey) + '`')
  if ($already.Count -ge 1) {
    if ($already.Count -gt 1) { throw "ADR-027 log has $($already.Count) rows for the '$OverrideKey' override; remove the duplicate by hand." }
    Say "  already applied: override row for '$OverrideKey' (no change)"
    return
  }
  $anchor = Find-Anchor $lines '^## Not excluded\s*$' "ADR-027 log '## Not excluded' heading"
  $section = @(
    '## Overrides',
    '',
    'A pnpm `overrides` entry in [pnpm-workspace.yaml](../../pnpm-workspace.yaml) is a supply-chain key (human-only). It needs no row for the release-age gate unless the patched version is younger than 3 days (then it also needs an exact `minimumReleaseAgeExclude` entry and a row above); it is logged here so it is pruned when the cause is gone. `nx run supply-chain:gates` requires every override to be an exact version (`pin.non-exact-version`).',
    '',
    '| Setting     | Entry                                    | Published        | Reason                                                                                                                                                                                                                       | Remove when                                                         | Approved by |',
    '| ----------- | ---------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------- |',
    ('| `overrides` | `' + $OverrideKey + '` -> `' + $OverrideValue + '` | 2026-10-08 12:07 | `@angular/build` 22.2.3 pins vite 8.3.0, which bundles launch-editor with GHSA-587h-7wmj-h5pm (CVSS 7.5), GHSA-698v-4r3x-3vcv and GHSA-r825-w8mm-5pxw (6.3), fixed in vite 8.3.3. 8.3.4 is the version `vitest` and `astro` already resolve, so the lockfile has one vite. Dev-server only (`ng serve`); no source imports vite and no bundle contains it. | `@angular/build` resolves vite >= 8.3.3 itself (next Angular CLI patch) | maintainer  |'),
    ''
  )
  $lines.InsertRange($anchor, [string[]]$section)
  Say "  + ADR-027 log: new 'Overrides' section with the row for '$OverrideKey' -> $OverrideValue"
  $script:Changes++
  Save-Lines $Path $doc
}

# ---- 3. CODEOWNERS ---------------------------------------------------------------------------

$Owner = '@RafaelJCamara'

# Path, the existing line to insert after, and why (the open question that proposed it).
$CodeownersEntries = @(
  @{ Path = '/tools/semantics-audit/';                  After = '/tools/semantics-evidence/';          Why = 'OQ-107' }
  @{ Path = '/libs/shared/domain-model/';               After = '/tools/semantics-audit/';             Why = 'OQ-107 (version parser the era resolver relies on)' }
  @{ Path = '/tools/arch-tests/';                       After = '/libs/shared/domain-model/';          Why = 'OQ-429 (enforces I-2, A-9 and the I-14 independence rule)' }
  @{ Path = '/tools/conformance-ci/';                   After = '/tools/arch-tests/';                  Why = 'OQ-492, OQ-633 (trust:critical)' }
  @{ Path = '/libs/engine/kernel/src/scheduler/';       After = '/libs/engine/kernel/src/actions/';    Why = 'OQ-178 (BrokerScheduler, I-8)' }
  @{ Path = '/libs/engine/ports/';                      After = '/libs/engine/kernel/src/scheduler/';  Why = 'OQ-178 (trust:critical)' }
  @{ Path = '/testing/broker-lab/';                     After = '/apps/conformance/';                  Why = 'OQ-86, OQ-429, OQ-458 (trust:critical; also covers versions.json)' }
  @{ Path = '/libs/testkit/';                           After = '/testing/broker-lab/';                Why = 'OQ-86, OQ-429, OQ-458 (also covers src/it/run-record.ts, conformance.it.ts, run-conformance.ts)' }
  @{ Path = '/.github/actions/';                        After = '/.github/workflows/';                 Why = 'OQ-633 (composite actions the conformance gate runs)' }
)
$TagDerivedEntries = @(
  @{ Path = '/libs/engine/adapter-amqp091/';            After = '/libs/engine/svc-mcp/';               Why = 'tag trust:critical, no open question' }
  @{ Path = '/libs/engine/jobs/';                       After = '/libs/engine/adapter-amqp091/';       Why = 'tag trust:critical, no open question' }
  @{ Path = '/libs/engine/svc-ops/';                    After = '/libs/engine/jobs/';                  Why = 'tag trust:critical, no open question' }
  @{ Path = '/libs/ui/design/';                         After = '/apps/desktop/src/preload/';          Why = 'tag trust:critical, no open question' }
)

function Update-Codeowners([string]$Path) {
  Say "[3/3] $Path"
  $doc = Read-Lines $Path
  $lines = $doc.Lines
  $entries = @($CodeownersEntries)
  if ($IncludeTagDerived) { $entries += $TagDerivedEntries }
  $applied = 0

  # Verify every anchor first (an anchor may be a line this run is about to add).
  $adding = @($entries | ForEach-Object { $_.Path })
  foreach ($e in $entries) {
    $hit = Find-AllLines $lines ('^' + [regex]::Escape($e.After) + '\s+@')
    if ($hit.Count -eq 0 -and $adding -notcontains $e.After) {
      throw "CODEOWNERS anchor '$($e.After)' (for '$($e.Path)') is missing and is not added by this run. Nothing was written."
    }
  }

  foreach ($e in $entries) {
    $have = Find-AllLines $lines ('^' + [regex]::Escape($e.Path) + '\s+@')
    if ($have.Count -ge 1) {
      if ($have.Count -gt 1) { throw "CODEOWNERS has $($have.Count) lines for '$($e.Path)'; remove the duplicate by hand." }
      continue
    }
    $at = Find-AllLines $lines ('^' + [regex]::Escape($e.After) + '\s+@')
    $line = $e.Path.PadRight(56) + $Owner
    $lines.Insert($at[0] + 1, $line)
    Say "  + $($line.TrimEnd())   [$($e.Why)]"
    $applied++
  }
  if ($applied -eq 0) {
    Say "  already applied: all $($entries.Count) CODEOWNERS lines present (no change)"
    return
  }
  $script:Changes += $applied
  Save-Lines $Path $doc
}

# ---- run -------------------------------------------------------------------------------------

$ws = Join-Path $Root 'pnpm-workspace.yaml'
$adr = Join-Path $Root 'docs/adr/ADR-027-log.md'
$co = Join-Path $Root 'CODEOWNERS'
foreach ($f in $ws, $adr, $co) { if (-not (Test-Path -LiteralPath $f)) { throw "Missing $f (is -Root the repository root?)" } }

Say "Root: $Root$(if ($WhatIfPreference) { '   (dry run: nothing is written or run)' })"
Update-Workspace $ws
Update-AdrLog $adr
Update-Codeowners $co

if ($script:Changes -eq 0) { Say 'Nothing to change: the batch was already applied.' }
else { Say "$($script:Changes) change(s) $(if ($WhatIfPreference) { 'would be made' } else { 'made' })." }

if ($WhatIfPreference) { Say 'Dry run: pnpm install and the supply-chain gates were not run.'; return }

Push-Location $Root
try {
  if (-not $SkipInstall) {
    Say 'Running: pnpm install'
    pnpm install
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed ($LASTEXITCODE)" }
    $lock = Join-Path $Root 'pnpm-lock.yaml'
    if (Select-String -LiteralPath $lock -Pattern '^  vite@8\.3\.0(:\s*$|\()' -Quiet) {
      throw 'pnpm-lock.yaml still resolves vite@8.3.0 after the override. Run `pnpm why vite` and report.'
    }
    Say 'Lockfile check: no vite@8.3.0 left.'
  }
  if (-not $SkipGates) {
    Say 'Running: pnpm nx run supply-chain:gates'
    pnpm nx run supply-chain:gates
    if ($LASTEXITCODE -ne 0) { throw "supply-chain:gates failed ($LASTEXITCODE)" }
  }
}
finally { Pop-Location }

Say 'Done. Review with `git diff`, then use the git add / git commit -s commands at the end of docs/maintainer/BATCH.md.'
