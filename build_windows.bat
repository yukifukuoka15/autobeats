@echo off
cd /d "%~dp0"
set "PATH=%~dp0tools;%PATH%;%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin"
call npm install
if errorlevel 1 goto failed
call npm run package:win
:failed
pause
