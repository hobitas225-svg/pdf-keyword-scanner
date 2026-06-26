@echo off
setlocal enabledelayedexpansion
title PDF Keyword Scanner - Update site
cd /d "%~dp0"

echo ============================================================
echo  Push your changes to GitHub (auto-deploys the live site)
echo ============================================================
echo.

git add -A

REM if nothing is staged, skip the commit and just push anything unpushed
git diff --cached --quiet && (echo No new changes to commit. & goto push)

set /p msg=Describe the change (press Enter for a default message):
if "!msg!"=="" set msg=Update PDF Keyword Scanner
git commit -m "!msg!"

:push
echo.
echo Pushing to GitHub...
git push origin main
if errorlevel 1 (
  echo.
  echo Push failed. If it mentions authentication, run:  gh auth login
  echo.
  pause
  exit /b 1
)

echo.
echo ============================================================
echo  Done. The live site rebuilds in about a minute:
echo     https://hobitas225-svg.github.io/pdf-keyword-scanner/
echo  Refresh that page (or your local copy) to see the changes.
echo ============================================================
echo.
pause
