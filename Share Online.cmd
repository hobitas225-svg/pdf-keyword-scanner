@echo off
title PDF Keyword Scanner - Share Online
cd /d "%~dp0"
set PORT=8131

echo ============================================================
echo  PDF Keyword Scanner - public share via Cloudflare tunnel
echo ============================================================
echo.
echo Starting the local server...
start "PDF Scanner server" /min cmd /c "node serve.mjs"

REM give the server a moment to bind the port
ping 127.0.0.1 -n 3 >nul

echo.
echo Opening a public https link (free, no login). It appears below as
echo    https://something-random.trycloudflare.com
echo.
echo Share that link with anyone. Each person enters THEIR OWN Anthropic
echo API key in the app (it stays in their browser).
echo.
echo Keep this window open while sharing. Close it to stop.
echo ============================================================
echo.

"C:\Users\SpareA\cloudflared\cloudflared.exe" tunnel --url http://localhost:%PORT%

echo.
echo Tunnel closed. Press any key to exit.
pause >nul
