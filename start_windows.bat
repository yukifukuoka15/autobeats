@echo off
cd /d "%~dp0"
set "PATH=%~dp0tools;%PATH%;%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin"
if not exist node_modules call npm install
if errorlevel 1 goto failed
call npm run dev:editor
:failed
if errorlevel 1 pause
