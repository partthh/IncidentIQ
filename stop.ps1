# ---------------------------------------------------------------------------
# Stops everything SentinelAI needs: PostgreSQL, the backend, the dashboard.
#
#   .\stop.ps1
#
# Only processes this project started are touched -- the match is on the command
# line, not the image name. Anything of yours that merely happens to be called
# "java.exe" or "node.exe" is left alone.
# ---------------------------------------------------------------------------

$ErrorActionPreference = 'Continue'
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

function Stop-ByCommandLine {
    param([string]$Label, [string]$Pattern)

    $targets = Get-CimInstance Win32_Process |
        Where-Object { $_.CommandLine -and $_.CommandLine -like $Pattern -and $_.ProcessId -ne $PID }

    if (-not $targets) {
        Write-Host "[stop] $Label : not running"
        return
    }

    foreach ($t in $targets) {
        Write-Host "[stop] $Label : killing PID $($t.ProcessId)"
        Stop-Process -Id $t.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "[stop] stopping SentinelAI"

# Order matters: shut the callers down before the database they are connected to,
# so nothing is killed mid-transaction.
Stop-ByCommandLine -Label 'dashboard (vite)' -Pattern '*vite*'
Stop-ByCommandLine -Label 'backend'        -Pattern '*com.sentinelai.SentinelAiApplication*'

# PostgreSQL. Located from the running process rather than hard-coded, because this
# project's database is an embedded install under the temp directory and its exact
# path is not something to guess at.
$pg = Get-CimInstance Win32_Process -Filter "Name='postgres.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -like '*opencode/pgdata*' } |
      Select-Object -First 1

if ($pg) {
    $pgCtl = Join-Path (Split-Path $pg.ExecutablePath -Parent) 'pg_ctl.exe'
    $dataDir = $pg.CommandLine -replace '.*-D\s+"?([^"\s]+)".*', '$1'

    if (Test-Path $pgCtl) {
        # -m fast sends SIGINT, so open transactions roll back cleanly. -m immediate
        # crash-recovers instead: faster, and it discards work.
        Write-Host "[stop] postgres : pg_ctl stop -m fast"
        & $pgCtl -D $dataDir -m fast -w stop 2>&1 | ForEach-Object { Write-Host "        $_" }
    } else {
        Write-Host "[stop] postgres : pg_ctl.exe not found, stopping the process instead"
        Stop-Process -Id $pg.ProcessId -Force -ErrorAction SilentlyContinue
    }

    # Do not trust pg_ctl's exit code alone: the postmaster can outlive the call by a
    # moment, and an earlier version of this script reported success and then found the
    # port still held. Confirm the port actually came free, then escalate.
    for ($i = 0; $i -lt 20; $i++) {
        if (-not (Get-NetTCPConnection -LocalPort 55432 -State Listen -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 500
    }
    if (Get-NetTCPConnection -LocalPort 55432 -State Listen -ErrorAction SilentlyContinue) {
        $still = Get-CimInstance Win32_Process -Filter "Name='postgres.exe'" -ErrorAction SilentlyContinue |
                 Where-Object { $_.CommandLine -like '*opencode/pgdata*' }
        if ($still) {
            Write-Host "[stop] postgres : still listening after pg_ctl, forcing PID $($still.ProcessId)"
            Stop-Process -Id $still.ProcessId -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 2
        }
    }
} else {
    Write-Host "[stop] postgres : not running"
}

Start-Sleep -Seconds 1

foreach ($port in 8080, 5173, 55432) {
    $busy = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($busy) {
        Write-Host "[stop] WARNING port $port is still listening (PID $($busy[0].OwningProcess))"
    } else {
        Write-Host "[stop] port $port free"
    }
}

Write-Host ""
Write-Host "[stop] done. Ports 8080 / 5173 / 55432 should all be free."