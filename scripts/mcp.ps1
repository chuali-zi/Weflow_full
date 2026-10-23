$ErrorActionPreference = 'Stop'
$env:NODE_OPTIONS = ''
$env:NODE_PATH = ''
$env:PYTHONHOME = ''
$env:PYTHONPATH = ''
$mcpProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$mcpServer = Join-Path $mcpProjectRoot 'build\mcp\server.cjs'
if (-not (Test-Path -LiteralPath $mcpServer)) {
    [Console]::Error.WriteLine('MCP is not built. Prepare the project environment, then run npm run build:mcp.')
    exit 1
}
$mcpElectron = Join-Path $mcpProjectRoot 'node_modules\electron\dist\electron.exe'
$mcpNode = $null
if (Test-Path -LiteralPath $mcpElectron) {
    $mcpNode = $mcpElectron
    $env:ELECTRON_RUN_AS_NODE = '1'
} else {
    $mcpPortableNode = Get-ChildItem -LiteralPath (Join-Path $mcpProjectRoot '.runtime') -Directory -Filter 'node-*-win-x64' -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if ($mcpPortableNode) { $mcpNode = Join-Path $mcpPortableNode.FullName 'node.exe' }
    if (-not $mcpNode -or -not (Test-Path -LiteralPath $mcpNode)) {
        $mcpNodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
        if ($mcpNodeCommand) { $mcpNode = $mcpNodeCommand.Source }
    }
}
if (-not $mcpNode) { [Console]::Error.WriteLine('Node runtime is missing. Prepare the project with the existing launch script.'); exit 1 }
$mcpVersion = (& $mcpNode --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $mcpVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) {
    [Console]::Error.WriteLine('MCP needs Node 22+ or the project Electron runtime. Prepare the project with the existing launch script.')
    exit 1
}
$env:WEFLOW_BACKEND_ROOT = Join-Path $mcpProjectRoot 'python'
$env:WEFLOW_MCP_ASSETS = Join-Path $mcpProjectRoot 'build\mcp'
$mcpPython = @((Join-Path $mcpProjectRoot '.venv\Scripts\python.exe'), (Join-Path $mcpProjectRoot '.runtime\python\python.exe')) |
    Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $mcpPython) { [Console]::Error.WriteLine('Project Python is missing. Prepare the project with the existing launch script.'); exit 1 }
$env:WEFLOW_PYTHON = $mcpPython
& $mcpNode $mcpServer @args
exit $LASTEXITCODE
