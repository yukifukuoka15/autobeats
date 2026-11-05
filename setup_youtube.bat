@echo off
cd /d "%~dp0"
python -m pip install -r apps\chart-editor\resources\youtube\requirements.txt
if errorlevel 1 pause
