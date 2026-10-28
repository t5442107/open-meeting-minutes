$ErrorActionPreference = 'Stop'

$bundleDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$replacement = Join-Path $bundleDir '__uninstaller-nsis-huiyi-jiyao.exe'
$hashFile = "$replacement.sha256"
$expectedDisplayName = '^会议纪要助手(?: \d+\.\d+\.\d+)?$'
$uninstallerName = 'Uninstall 会议纪要助手.exe'
$appExecutable = '会议纪要助手.exe'

if (-not (Test-Path -LiteralPath $replacement -PathType Leaf) -or -not (Test-Path -LiteralPath $hashFile -PathType Leaf)) {
  throw '修复文件不完整。请将安装包旁生成的卸载器、SHA-256 文件和本脚本放在同一目录。'
}
$expectedHash = ((Get-Content -LiteralPath $hashFile -Raw).Trim() -split '\s+')[0].ToUpperInvariant()
$actualHash = (Get-FileHash -LiteralPath $replacement -Algorithm SHA256).Hash.ToUpperInvariant()
if ($expectedHash -notmatch '^[A-F0-9]{64}$' -or $actualHash -ne $expectedHash) {
  throw '卸载器 SHA-256 校验失败，未修改任何文件。'
}

$registryRoots = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$matches = foreach ($root in $registryRoots) {
  Get-ItemProperty -Path $root -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -match $expectedDisplayName -and $_.InstallLocation }
}
$candidates = @($matches | ForEach-Object {
  $installDir = [IO.Path]::GetFullPath($_.InstallLocation.TrimEnd('\'))
  $oldUninstaller = Join-Path $installDir $uninstallerName
  $appPath = Join-Path $installDir $appExecutable
  if ((Test-Path -LiteralPath $oldUninstaller -PathType Leaf) -and (Test-Path -LiteralPath $appPath -PathType Leaf)) {
    [PSCustomObject]@{ DisplayName = $_.DisplayName; InstallDir = $installDir; Uninstaller = $oldUninstaller }
  }
} | Group-Object { $_.InstallDir.ToLowerInvariant() } | ForEach-Object { $_.Group[0] })

if ($candidates.Count -ne 1) {
  throw "找到 $($candidates.Count) 个符合名称、注册表安装路径和程序文件的安装。为避免替换错误文件，未作更改。"
}
$target = $candidates[0]
$running = Get-Process -Name '会议纪要助手' -ErrorAction SilentlyContinue
if ($running) { throw '请先退出会议纪要助手，然后重新运行本脚本。' }

$staging = Join-Path $target.InstallDir '.huiyi-uninstaller-repair.tmp'
try {
  Copy-Item -LiteralPath $replacement -Destination $staging -Force
  Move-Item -LiteralPath $staging -Destination $target.Uninstaller -Force
} finally {
  Remove-Item -LiteralPath $staging -Force -ErrorAction SilentlyContinue
}

Write-Host "已用 SHA-256 已验证的卸载器替换：$($target.Uninstaller)"
Write-Host '现在可从 Windows“设置 → 应用”卸载会议纪要助手。此操作只替换卸载器，不删除会议记录、设置、模型或运行环境。'
