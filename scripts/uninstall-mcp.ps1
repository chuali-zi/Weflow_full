[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('codex', 'claude')]
    [string]$Client,
    [ValidateNotNullOrEmpty()]
    [string]$Name = 'weflow',
    [ValidateSet('user', 'local', 'project')]
    [string]$Scope = 'user',
    [string]$Cli
)

$ErrorActionPreference = 'Stop'

if ($Client -eq 'codex' -and $Scope -ne 'user') {
    throw 'This CLI removes user-level MCP registrations. Use -Scope user.'
}

if (-not $Cli) {
    $weflowClientCommand = Get-Command "$Client.exe", "$Client.cmd", $Client -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($weflowClientCommand) { $Cli = $weflowClientCommand.Source }
}
if (-not $Cli -and $Client -eq 'codex') {
    $weflowClientBin = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
    if (Test-Path -LiteralPath $weflowClientBin) {
        $Cli = Get-ChildItem -LiteralPath $weflowClientBin -Recurse -File -Filter codex.exe |
            Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1 -ExpandProperty FullName
    }
}
if (-not $Cli) { throw "Cannot find $Client CLI. Provide its path with -Cli." }

$weflowRemoveArgs = @('mcp', 'remove', $Name)
if ($Client -eq 'claude') { $weflowRemoveArgs += @('--scope', $Scope) }
$weflowTarget = if ($Client -eq 'claude') { "$Client/$Scope/$Name" } else { "$Client/$Name" }

if ($PSCmdlet.ShouldProcess($weflowTarget, 'Remove MCP registration')) {
    & $Cli @weflowRemoveArgs
    if ($LASTEXITCODE -ne 0) { throw "MCP removal failed (exit $LASTEXITCODE)." }
    Write-Output "Removed $weflowTarget. WeFlow program, profiles and WeChat data were preserved."
    Write-Output 'Reload MCP or start a new client session to apply the change.'
}
