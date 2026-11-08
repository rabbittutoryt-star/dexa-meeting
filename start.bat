@echo off
setlocal
cd /d "%~dp0"
if not exist .env copy /y .env.example .env >nul
set AUTO_OPEN_BROWSER=1

where py >nul 2>nul
if not errorlevel 1 (
  py -3 server.py
  goto :done
)

where python >nul 2>nul
if not errorlevel 1 (
  python server.py
  goto :done
)

echo.
echo Python 3.10 or newer is required.
echo Install Python from https://www.python.org/downloads/
echo During installation, enable "Add Python to PATH".
echo.

:done
pause
