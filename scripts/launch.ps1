param([switch]$SetupOnly, [switch]$BuildOnly)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Use this PowerShell's utility module when a parent process supplies another runtime's module path.
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -Force
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $projectRoot
$runtimeDir = Join-Path $projectRoot '.runtime'
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null

function Run-Checked([string]$Executable, [string[]]$Arguments) {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Command failed: $Executable (exit $LASTEXITCODE)." }
}
function Test-Pip([string]$Executable) {
    $ErrorActionPreference = 'SilentlyContinue'
    & $Executable -m pip --version *> $null
    return $LASTEXITCODE -eq 0
}

Write-Host 'WeFlow local edition - preparing your local environment...'
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$useSystemNode = $false
if ($nodeCommand) {
    $nodeVersion = [version]((& $nodeCommand.Source --version).TrimStart('v'))
    $useSystemNode = $nodeVersion -ge [version]'22.12.0'
}
if (-not $useSystemNode) {
    $portableNode = Get-ChildItem -LiteralPath $runtimeDir -Directory -Filter 'node-*-win-x64' | Select-Object -First 1
    if (-not $portableNode) {
        Write-Host 'Downloading portable Node.js from nodejs.org...'
        $versions = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json'
        $nodeRelease = $versions | Where-Object { $_.version.StartsWith('v22.') -and $_.lts } | Select-Object -First 1
        if (-not $nodeRelease) { throw 'Could not locate a supported Node.js release.' }
        $archive = Join-Path $runtimeDir 'node.zip'
        Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$($nodeRelease.version)/node-$($nodeRelease.version)-win-x64.zip" -OutFile $archive
        Expand-Archive -LiteralPath $archive -DestinationPath $runtimeDir -Force
        $portableNode = Get-Item -LiteralPath (Join-Path $runtimeDir "node-$($nodeRelease.version)-win-x64")
    }
    $env:PATH = "$($portableNode.FullName);$env:PATH"
}
$npmExecutable = (Get-Command npm.cmd).Source

$pythonExecutable = Join-Path $projectRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonExecutable)) {
    $systemPython = Get-Command python.exe -ErrorAction SilentlyContinue
    $validPython = $false
    if ($systemPython) {
        $ErrorActionPreference = 'SilentlyContinue'
        $pythonCheck = & $systemPython.Source -c 'import sys,struct; print(int(sys.version_info >= (3,12) and struct.calcsize(chr(80))==8))' 2>$null
        $validPython = $LASTEXITCODE -eq 0 -and $pythonCheck -eq '1'
        $ErrorActionPreference = 'Stop'
    }
    if ($validPython) {
        Run-Checked $systemPython.Source @('-m', 'venv', '.venv')
    } else {
        $pythonDir = Join-Path $runtimeDir 'python'
        $pythonExecutable = Join-Path $pythonDir 'python.exe'
        if (-not (Test-Path -LiteralPath $pythonExecutable)) {
            Write-Host 'Downloading portable Python from python.org...'
            $pythonVersion = '3.13.16'
            $archive = Join-Path $runtimeDir 'python.zip'
            Invoke-WebRequest -UseBasicParsing -Uri "https://www.python.org/ftp/python/$pythonVersion/python-$pythonVersion-embed-amd64.zip" -OutFile $archive
            Expand-Archive -LiteralPath $archive -DestinationPath $pythonDir -Force
            $pathFile = Get-ChildItem -LiteralPath $pythonDir -Filter 'python*._pth' | Select-Object -First 1
            Add-Content -LiteralPath $pathFile.FullName -Value "`n../../python`nLib/site-packages`nimport site" -Encoding Ascii
        }
        if (-not (Test-Pip $pythonExecutable)) {
            $getPip = Join-Path $runtimeDir 'get-pip.py'
            Invoke-WebRequest -UseBasicParsing -Uri 'https://bootstrap.pypa.io/get-pip.py' -OutFile $getPip
            Run-Checked $pythonExecutable @($getPip, '--no-warn-script-location', '--cache-dir', (Join-Path $runtimeDir 'pip-cache'))
        }
    }
}
$env:WEFLOW_PYTHON = $pythonExecutable
if (-not (Test-Pip $pythonExecutable)) {
    Write-Host 'Repairing the local Python package installer...'
    Run-Checked $pythonExecutable @('-m', 'ensurepip', '--upgrade', '--default-pip')
}
$env:WEFLOW_BACKEND_ROOT = Join-Path $projectRoot 'python'
$requirements = Join-Path $projectRoot 'python\requirements.txt'
$requirementsHash = (Get-FileHash -LiteralPath $requirements -Algorithm SHA256).Hash
$pythonStamp = Join-Path $runtimeDir 'python-dependencies.txt'
if (-not (Test-Path -LiteralPath $pythonStamp) -or (Get-Content -LiteralPath $pythonStamp -Raw).Trim() -ne $requirementsHash) {
    Write-Host 'Installing the bundled database backend...'
    Run-Checked $pythonExecutable @('-m', 'pip', 'install', '--disable-pip-version-check', '--cache-dir', (Join-Path $runtimeDir 'pip-cache'), '-r', $requirements)
    Set-Content -LiteralPath $pythonStamp -Value $requirementsHash -Encoding Ascii
}
$lockHash = (Get-FileHash -LiteralPath 'package-lock.json' -Algorithm SHA256).Hash
$nodeStamp = Join-Path $runtimeDir 'node-dependencies.txt'
if (-not (Test-Path -LiteralPath 'node_modules\electron\dist\electron.exe') -or
    -not (Test-Path -LiteralPath $nodeStamp) -or (Get-Content -LiteralPath $nodeStamp -Raw).Trim() -ne $lockHash) {
    Write-Host 'Installing WeFlow dependencies. The first run can take several minutes...'
    Run-Checked $npmExecutable @('ci', '--legacy-peer-deps', '--no-audit', '--no-fund', '--cache', '.npm-cache')
    Set-Content -LiteralPath $nodeStamp -Value $lockHash -Encoding Ascii
}
if ($SetupOnly) { Write-Host 'Setup complete.'; exit 0 }
$buildStamp = Join-Path $runtimeDir 'app-build.txt'
$sources = Get-ChildItem -LiteralPath 'src','electron','python','shared' -Recurse -File |
    Where-Object { $_.Extension -in '.ts','.tsx','.scss','.css','.py','.json' }
$sources += Get-Item -LiteralPath 'package.json','package-lock.json','vite.config.ts'
$newestSource = ($sources | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1).LastWriteTimeUtc
if (-not (Test-Path -LiteralPath 'dist-electron\main.js') -or -not (Test-Path -LiteralPath $buildStamp) -or
    (Get-Item -LiteralPath $buildStamp).LastWriteTimeUtc -lt $newestSource) {
    Write-Host 'Building WeFlow. Future launches will reuse this build...'
    Run-Checked $npmExecutable @('run', 'build:app')
    Set-Content -LiteralPath $buildStamp -Value 'ready' -Encoding Ascii
}
if ($BuildOnly) { Write-Host 'Build complete.'; exit 0 }
try { & (Join-Path $PSScriptRoot 'create-desktop-shortcut.ps1') }
catch { Write-Warning "桌面快捷方式未创建：$($_.Exception.Message)" }
Write-Host 'Opening WeFlow...'
Run-Checked $npmExecutable @('start')
