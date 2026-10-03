$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$cliArguments = @($args)
function Prepare-Environment([string]$Mode) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'launch.ps1') $Mode |
        ForEach-Object { [Console]::Error.WriteLine($_) }
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
$pythonCandidates = @($env:WEFLOW_PYTHON, (Join-Path $projectRoot '.venv\Scripts\python.exe'), (Join-Path $projectRoot '.runtime\python\python.exe'))
$pythonExecutable = $pythonCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $pythonExecutable) {
    Prepare-Environment '-SetupOnly'
    $pythonExecutable = $pythonCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
}
if (-not $pythonExecutable) { throw 'Python runtime setup did not complete.' }
if ($cliArguments | Where-Object { $_ -in @('prepare', 'configure', 'launch') }) {
    Prepare-Environment '-BuildOnly'
}
$env:PYTHONPATH = Join-Path $projectRoot 'python'
$env:PYTHONIOENCODING = 'utf-8'
& $pythonExecutable -m weflow_backend cli @cliArguments
exit $LASTEXITCODE
