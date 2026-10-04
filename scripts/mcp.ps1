$ErrorActionPreference = 'Stop'
$mcpProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$mcpServer = Join-Path $mcpProjectRoot 'build\mcp\server.cjs'
if (-not (Test-Path -LiteralPath $mcpServer)) {
    [Console]::Error.WriteLine('MCP is not built. Prepare the project environment, then run npm run build:mcp.')
    exit 1
}
$mcpNodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$mcpPortableNode = Get-ChildItem -LiteralPath (Join-Path $mcpProjectRoot '.runtime') -Directory -Filter 'node-*-win-x64' -ErrorAction SilentlyContinue | Select-Object -First 1
$mcpNode = if ($mcpNodeCommand) { $mcpNodeCommand.Source } elseif ($mcpPortableNode) { Join-Path $mcpPortableNode.FullName 'node.exe' } else { $null }
if (-not $mcpNode) {
    $mcpElectron = Join-Path $mcpProjectRoot 'node_modules\electron\dist\electron.exe'
    if (Test-Path -LiteralPath $mcpElectron) { $mcpNode = $mcpElectron; $env:ELECTRON_RUN_AS_NODE = '1' }
}
if (-not $mcpNode) { [Console]::Error.WriteLine('Node runtime is missing. Prepare the project with the existing launch script.'); exit 1 }
$env:WEFLOW_BACKEND_ROOT = Join-Path $mcpProjectRoot 'python'
$env:WEFLOW_MCP_ASSETS = Join-Path $mcpProjectRoot 'build\mcp'
& $mcpNode $mcpServer @args
exit $LASTEXITCODE
