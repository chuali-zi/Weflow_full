param(
    [string]$ShortcutPath,
    [string]$UserData = (Join-Path $env:APPDATA 'WeFlow-full'),
    [ValidateSet('live', 'snapshot')][string]$Mode = 'live'
)
$ErrorActionPreference = 'Stop'
$shortcutProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$shortcutElectron = Join-Path $shortcutProjectRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $shortcutElectron) -or
    -not (Test-Path -LiteralPath (Join-Path $shortcutProjectRoot 'dist-electron\main.js'))) {
    throw '请先运行“启动 WeFlow.cmd -BuildOnly”准备 GUI。'
}
if (-not $ShortcutPath) {
    $shortcutName = if ($Mode -eq 'live') { 'WeFlow Live.lnk' } else { 'WeFlow Snapshot.lnk' }
    $ShortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) $shortcutName
}
$shortcutProfile = [IO.Path]::GetFullPath($UserData)
$shortcutShell = New-Object -ComObject WScript.Shell
$shortcut = $shortcutShell.CreateShortcut([IO.Path]::GetFullPath($ShortcutPath))
$shortcut.TargetPath = $shortcutElectron
$shortcut.Arguments = '"' + $shortcutProjectRoot + '" --mode ' + $Mode + ' --show --user-data "' + $shortcutProfile + '"'
$shortcut.WorkingDirectory = $shortcutProjectRoot
$shortcut.IconLocation = (Join-Path $shortcutProjectRoot 'public\icon.ico') + ',0'
$shortcut.Description = 'WeFlow (' + $Mode + ')'
$shortcut.Save()
Write-Host "桌面快捷方式已创建：$ShortcutPath"
