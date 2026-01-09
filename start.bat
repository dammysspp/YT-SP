@echo off
REM MediaVault - Startup Script for Windows

echo ========================================
echo    MediaVault - Video/Audio Downloader
echo ========================================
echo.

REM Check if Python is installed
where python >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Python is not installed or not in PATH
    echo Please install Python 3.8+ from https://python.org
    pause
    exit /b 1
)

REM Check Python version
for /f "tokens=2" %%i in ('python --version 2^>^&1') do set PYVER=%%i
echo [INFO] Found Python %PYVER%

REM Check if venv exists, create if not
if not exist "venv" (
    echo [INFO] Creating virtual environment...
    python -m venv venv
)

REM Activate venv
echo [INFO] Activating virtual environment...
call venv\Scripts\activate.bat

REM Install/upgrade dependencies
echo [INFO] Installing dependencies...
pip install -q -r backend\requirements.txt

REM Check for FFmpeg
where ffmpeg >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [WARNING] FFmpeg not found in PATH!
    echo Video merging and audio conversion require FFmpeg.
    echo Install with: choco install ffmpeg
    echo Or download from: https://ffmpeg.org/download.html
    echo.
)

echo.
echo [INFO] Starting MediaVault server...
echo [INFO] Open http://localhost:5000 in your browser
echo [INFO] Press Ctrl+C to stop the server
echo.

python backend\app.py
