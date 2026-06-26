@echo off
title PDF Keyword Scanner - allow on office network (admin)

REM --- self-elevate to Administrator ---
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo ============================================================
echo  Letting other devices on your network reach the PDF Scanner
echo  (adds one inbound Allow rule for TCP port 8131).
echo ============================================================
echo.

powershell -NoProfile -Command "if (-not (Get-NetFirewallRule -DisplayName 'PDF Keyword Scanner (8131)' -ErrorAction SilentlyContinue)) { New-NetFirewallRule -DisplayName 'PDF Keyword Scanner (8131)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8131 -Profile Any | Out-Null; Write-Host 'Firewall rule added for port 8131.' } else { Write-Host 'Firewall rule already present.' }"

echo.
echo Other devices on the SAME network can now open one of these:
powershell -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '169.254.*' -and $_.IPAddress -ne '127.0.0.1' } | ForEach-Object { '    http://' + $_.IPAddress + ':8131    (' + $_.InterfaceAlias + ')' }"
echo.
echo Next: run "Start PDF Scanner.cmd" to launch the app, then open one of
echo those links on a phone/laptop joined to the same Wi-Fi / network.
echo.
echo To undo: delete the 'PDF Keyword Scanner (8131)' rule in Windows
echo Defender Firewall (Inbound Rules).
echo.
pause
