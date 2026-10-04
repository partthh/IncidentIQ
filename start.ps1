# ---------------------------------------------------------------------------
# Starts the whole stack: PostgreSQL, backend, dashboard.
#
#   .\start.ps1            start everything
#   .\start.ps1 -NoSim     skip the simulator
#
# Open http://localhost:5173 when it reports ready, and sign in as
# priya@sentinel.dev / sentinel123
#
# Why this script exists: on this machine Maven is not on PATH and the
# spring-boot-maven-plugin cannot be fetched offline, so `mvn spring-boot:run`
# does not work. The backend is therefore launched from a pre-built classpath.
# See "Offline builds" in backend\README.md.
# ---------------------------------------------------------------------------

param([switch]$NoSim)

# Maven and the JDK are not on PATH here, so set JAVA_HOME before anything tries
# to use it. mvn.cmd fails outright without it.
$env:JAVA_HOME = 'C:\Program Files\Java\jdk-21'

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$Temp        = $env:TEMP
if (-not $Temp) { $Temp = [System.IO.Path]::GetTempPath() }
$Temp        = $Temp.TrimEnd('\')

$JavaHome = $env:JAVA_HOME
$Maven    = "$Temp\opencode\tools\apache-maven-3.9.9\bin\mvn.cmd"
$ClasspathFile = "$Temp\opencode\cp.txt"
$PgData   = "$Temp\opencode\pgdata"
$LogDir   = "$Temp\opencode"

function Say  { param($m) Write-Host "[start] $m" }
function Fail { param($m) Write-Host "[start] ERROR: $m"; exit 1 }

function Wait-For {
    param([string]$Label, [scriptblock]$Probe, [int]$TimeoutSeconds = 90)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (& $Probe) { Say "$Label is ready"; return $true }
        Start-Sleep -Milliseconds 500
    }
    Say "$Label did NOT become ready within ${TimeoutSeconds}s"
    return $false
}

# ---------------------------------------------------------------- 1. PostgreSQL
if (-not (Test-Path "$PgData\PG_VERSION")) {
    Fail "No database at $PgData. One command cannot create it offline; see backend\README.md."
}

$alreadyUp = Get-NetTCPConnection -LocalPort 55432 -State Listen -ErrorAction SilentlyContinue
if ($alreadyUp) {
    Say "postgres already listening on 55432"
} else {
    $pg = Get-ChildItem "$Temp\embedded-pg" -Recurse -Filter 'pg_ctl.exe' -ErrorAction SilentlyContinue |
          Select-Object -First 1
    if (-not $pg) { Fail "pg_ctl.exe not found under $Temp\embedded-pg" }

    # The port is NOT passed as `-p 55432`. Doing so makes pg_ctl fail on this
    # machine with '"55432" is not recognized as an internal or external command',
    # and omitting it then silently starts the server on the default 5432, which
    # nothing is listening for. Instead the port is pinned in postgresql.conf,
    # which pg_ctl cannot misquote. The setting is idempotent.
    $conf = "$PgData\postgresql.conf"
    if (-not (Select-String -Path $conf -Pattern '^\s*port\s*=' -Quiet)) {
        Say "pinning port 55432 in postgresql.conf"
        Add-Content -Path $conf -Encoding ASCII -Value "`n# Added by start.ps1 -- the app and stop.ps1 both assume 55432.`nport = 55432`nlisten_addresses = '127.0.0.1'"
    }

    # -l sends server output to a log instead of this console, where it would
    # interleave with PowerShell's and make both unreadable.
    Say "starting postgres on 55432 (10-20s on a cold Windows cache)"
    & $pg.FullName -D $PgData -l "$LogDir\postgres.log" -w start | Out-Null
}

if (-not (Wait-For 'postgres' { Get-NetTCPConnection -LocalPort 55432 -State Listen -ErrorAction SilentlyContinue } 90)) {
    Fail "PostgreSQL did not start. See $LogDir\postgres.log"
}

# ------------------------------------------------------------------ 2. backend
if (-not (Test-Path "$JavaHome\bin\java.exe")) { Fail "JDK 21 not found at $JavaHome" }
if (-not (Test-Path $ClasspathFile)) {
    Fail "classpath file missing at $ClasspathFile`n         It is produced by the Maven build; see backend\README.md."
}
if (-not (Test-Path "$ProjectRoot\backend\target\classes\com\sentinelai\SentinelAiApplication.class")) {
    Say "backend classes not built yet -- building"
    Push-Location "$ProjectRoot\backend"
    & $Maven -B -o -DskipTests compile | Out-Null
    Pop-Location
}

Say "starting backend on 8080 (log: $LogDir\backend-run.log)"
$env:SENTINEL_DB_URL      = 'jdbc:postgresql://127.0.0.1:55432/postgres'
$env:SENTINEL_DB_USER     = 'postgres'
$env:SENTINEL_DB_PASSWORD = 'postgres'

# The classpath in cp.txt contains a relative "target\classes", so the working
# directory has to be backend/. Launching from anywhere else gives a class-not-found
# on the application's main class, which reads like a broken build.
Push-Location "$ProjectRoot\backend"
$backend = Start-Process -PassThru -WindowStyle Hidden -FilePath "$JavaHome\bin\java.exe" `
    -ArgumentList '-cp', (Get-Content $ClasspathFile -Raw), 'com.sentinelai.SentinelAiApplication' `
    -RedirectStandardOutput "$LogDir\backend-run.log" `
    -RedirectStandardError  "$LogDir\backend-error.log"
Pop-Location

if (-not (Wait-For 'backend' {
    try { (Invoke-RestMethod 'http://localhost:8080/actuator/health' -TimeoutSec 3).status -eq 'UP' } catch { $false }
} 120)) {
    Say "last lines of $LogDir\backend-run.log:"
    Get-Content "$LogDir\backend-run.log" -Tail 25 -ErrorAction SilentlyContinue | ForEach-Object { "        $_" }
    Fail "backend did not come up"
}
Say "backend PID $($backend.Id)"

# --------------------------------------------------------------- 3. dashboard
if (Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue) {
    Say "dashboard already listening on 5173"
} else {
    Say "starting dashboard on 5173 (log: $LogDir\frontend-dev.log)"
    $frontend = Start-Process -PassThru -WorkingDirectory "$ProjectRoot\frontend" `
        -FilePath 'cmd.exe' -ArgumentList '/c', 'npm run dev' `
        -RedirectStandardOutput "$LogDir\frontend-dev.log" `
        -RedirectStandardError  "$LogDir\frontend-error.log"
    if (-not (Wait-For 'dashboard' { Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue } 60)) {
        Fail "dashboard did not start. See $LogDir\frontend-dev.log"
    }
}

# --------------------------------------------------------------- 4. simulator
if ($NoSim) {
    Say "skipping the simulator (-NoSim)"
} else {
    Say "seeding the dashboard with traffic (log: $LogDir\simulator.log)"
    # A non-default seed on purpose. --seed 1 is deterministic, so a repeat run
    # replays identical sourceEventIds and the server correctly dedupes all of
    # them: "sent 40 / accepted 0 / duplicates 40". That is idempotency working,
    # but it looks like a failure, so the seed varies per start.
    $seed = Get-Random -Minimum 100 -Maximum 9999
    Start-Process -PassThru -WindowStyle Hidden -WorkingDirectory "$ProjectRoot\simulator" `
        -FilePath 'node.exe' `
        -ArgumentList 'src/cli.js', '--scenario', 'chaos', '--duration', '90', '--seed', $seed, '--speed', '2' `
        -RedirectStandardOutput "$LogDir\simulator.log" `
        -RedirectStandardError  "$LogDir\simulator-error.log" | Out-Null
    Say "simulator running (seed $seed, 90s)"
}

Write-Host ""
Write-Host "  dashboard   http://localhost:5173"
Write-Host "  backend     http://localhost:8080/actuator/health"
Write-Host "  sign in     priya@sentinel.dev / sentinel123"
Write-Host ""
Write-Host "  stop it all with  .\stop.ps1"