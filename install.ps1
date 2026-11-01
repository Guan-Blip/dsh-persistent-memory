<#
  一键安装：把 ai-persistent-memory 装进 DSH 的某个 profile。

  用法（在仓库根目录，PowerShell）：
    .\install.ps1
    .\install.ps1 -Profile web
    .\install.ps1 -Source "F:\DeepSeekcj"                 # 本地目录（开发用）
    .\install.ps1 -Source "github:你的用户名/dsh-persistent-memory"

  说明：DSH 安装完不会自动重启，脚本跑完请手动退出并重开 DSH。
#>
param(
  [string]$Profile = 'desktop',
  [string]$Source  = 'github:<你的GitHub用户名>/dsh-persistent-memory'
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command dsh -ErrorAction SilentlyContinue)) {
  throw '找不到 dsh 命令。请先安装 DeepSeek Harness 并至少打开过一次。'
}

Write-Host "正在安装：$Source" -ForegroundColor Cyan
Write-Host "目标 profile：$Profile" -ForegroundColor DarkGray

& dsh plugin --profile $Profile add $Source
if ($LASTEXITCODE -ne 0) {
  throw "安装失败（exit $LASTEXITCODE）。请检查上面 pnpm 的输出。"
}

Write-Host ''
Write-Host '✔ 安装完成。' -ForegroundColor Green
Write-Host '下一步：完全退出 DSH（含托盘）再重新打开，' -ForegroundColor Yellow
Write-Host '        然后打开 设置 → 左侧「🧠 长期记忆」查看面板。' -ForegroundColor Yellow
