@echo off
cd /d "%~dp0"
set "TRACE_DESKTOP_DATA=%~dp0.data\desktop"
set "TRACE_DATA_DIR=%~dp0.data"
if not exist "%TRACE_DESKTOP_DATA%" mkdir "%TRACE_DESKTOP_DATA%"
set "ELECTRON_RUN_AS_NODE="
start "Trace" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
