# 清理当前用户的 Windows 图标缓存。
#
# 适用场景：更换 Bowerbird 图标后，桌面快捷方式、任务栏固定项、开始菜单
# 仍显示旧图标（Windows 资源管理器会顽固缓存旧 .ico）。
#
# 运行后请重新固定任务栏图标 / 重开桌面快捷方式。安装版用户需先重装新版
# 安装包（Windows/dist 下的 setup.exe），再跑此脚本。
#
# 以普通用户身份运行即可（仅清理当前用户 %LOCALAPPDATA%）。

$ErrorActionPreference = "Stop"

Write-Host "停止资源管理器（explorer.exe）..." -ForegroundColor Yellow
taskkill /F /IM explorer.exe | Out-Null
Start-Sleep -Milliseconds 500

$LocalAppData = $env:LOCALAPPDATA
$ExplorerDir = Join-Path $LocalAppData "Microsoft\Windows\Explorer"

# 根图标缓存
Remove-Item (Join-Path $LocalAppData "IconCache.db") -Force -ErrorAction SilentlyContinue

# 缩略图 / 图标缓存数据库（按尺寸分多个文件）
Get-ChildItem $ExplorerDir -Filter "thumbcache_*.db" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Get-ChildItem $ExplorerDir -Filter "iconcache_*.db" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

Write-Host "图标缓存已清理，重启资源管理器..." -ForegroundColor Yellow
Start-Process explorer.exe

Write-Host "完成。" -ForegroundColor Green
Write-Host "若任务栏仍显示旧图标：取消固定旧图标 → 重新打开应用 → 再固定。" -ForegroundColor Cyan
