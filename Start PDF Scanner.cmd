@echo off
title PDF Keyword Scanner
cd /d "%~dp0"
set PORT=8131
echo Starting PDF Keyword Scanner...
start "" "http://localhost:%PORT%"
node serve.mjs
pause
