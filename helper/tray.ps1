# Clearcote Helper: the tray icon (Windows).
#
# The helper (lib\clearcote-helper.js) starts this script hidden, with Windows PowerShell, when it
# runs without a console window. It shows the Clearcote icon in the notification area with a menu:
#   Open status page / Paired sites...  open http://127.0.0.1:<Port>/ in your browser
#   Quit                                 asks the helper to close its browsers and stop
#
# It talks to the helper only at http://127.0.0.1:<Port>/tray/*, with the token the helper put in
# this process's environment (a new one every run). It exits when the helper's process ends.
# Nothing else: no downloads, no files written. See helper/tray.ts and helper/README.md.
#
# This file is ASCII on purpose: Windows PowerShell 5.1 reads a script without a BOM in the
# system's code page.

param(
  [Parameter(Mandatory = $true)][int]$Port,
  [Parameter(Mandatory = $true)][int]$HelperPid
)

$ErrorActionPreference = 'Stop'
$token = $env:CLEARCOTE_HELPER_TRAY_TOKEN
if (-not $token) { exit 2 }
# Programs started from here (your browser) do not need it.
Remove-Item Env:\CLEARCOTE_HELPER_TRAY_TOKEN -ErrorAction SilentlyContinue

# Holding the process object (not just its number) means a new process that later gets the same
# number is never mistaken for the helper.
$helper = Get-Process -Id $HelperPid -ErrorAction SilentlyContinue
if (-not $helper) { exit 3 }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$base = "http://127.0.0.1:$Port"

function Invoke-Helper([string]$Method, [string]$Path) {
  $req = [System.Net.HttpWebRequest]::Create($base + $Path)
  $req.Method = $Method
  $req.Proxy = $null
  $req.Timeout = 3000
  $req.Headers.Add('X-Clearcote-Tray', $token)
  if ($Method -eq 'POST') { $req.ContentLength = 0 }
  $res = $req.GetResponse()
  try {
    $reader = New-Object System.IO.StreamReader($res.GetResponseStream(), [System.Text.Encoding]::UTF8)
    return $reader.ReadToEnd()
  } finally {
    $res.Close()
  }
}

function Open-StatusPage {
  Start-Process "$base/"
}

$ellipsis = [string][char]0x2026
$icon = New-Object System.Windows.Forms.NotifyIcon
$iconFile = Join-Path $PSScriptRoot 'clearcote.ico'
try {
  $icon.Icon = New-Object System.Drawing.Icon($iconFile, [System.Windows.Forms.SystemInformation]::SmallIconSize)
} catch {
  $icon.Icon = [System.Drawing.SystemIcons]::Application
}
$icon.Text = 'Clearcote Helper'

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$open = $menu.Items.Add('Open status page')
$open.Font = New-Object System.Drawing.Font($open.Font, [System.Drawing.FontStyle]::Bold)
$open.add_Click({ Open-StatusPage })
$sites = $menu.Items.Add('Paired sites' + $ellipsis)
$sites.add_Click({ Open-StatusPage })
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$quit = $menu.Items.Add('Quit')
$script:quitting = $false
$quit.add_Click({
  $script:quitting = $true
  $icon.Text = 'Clearcote Helper - closing browsers' + $ellipsis
  try { [void](Invoke-Helper 'POST' '/tray/quit') } catch { }
})
$icon.ContextMenuStrip = $menu
$icon.add_DoubleClick({ Open-StatusPage })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({
  if ($helper.HasExited) {
    $timer.Stop()
    $icon.Visible = $false
    [System.Windows.Forms.Application]::Exit()
    return
  }
  if ($script:quitting) { return }
  try {
    $status = Invoke-Helper 'GET' '/tray/status' | ConvertFrom-Json
    $tip = [string]$status.tooltip
    if ($tip.Length -gt 63) { $tip = $tip.Substring(0, 63) }
    $icon.Text = $tip
  } catch { }
})

$icon.Visible = $true
$timer.Start()
# Say where it went, now that the console window has closed.
$icon.ShowBalloonTip(6000, 'Clearcote Helper is running', 'It runs from this icon now. Right-click it to open its page or to quit.', [System.Windows.Forms.ToolTipIcon]::Info)
try {
  [System.Windows.Forms.Application]::Run()
} finally {
  $timer.Stop()
  $icon.Visible = $false
  $icon.Dispose()
}
