@echo off
title Bionic Agent
cd /d "%~dp0"
echo Starting Bionic Agent...
npx --yes electron .
if %ERRORLEVEL% NEQ 0 (
  pause
)
