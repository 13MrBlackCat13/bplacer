@echo off
echo.
echo ============================================
echo Installing CF-Clearance-Scraper...
echo ============================================
echo.

REM Check if git is installed
git --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Git is not installed or not in PATH!
    echo Please install Git first: https://git-scm.com/downloads
    pause
    exit /b 1
)

REM Check if python is installed
python --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python is not installed or not in PATH!
    echo Please install Python first: https://python.org/downloads
    pause
    exit /b 1
)

echo Git and Python found!
echo.

REM Clone CF-Clearance-Scraper if not exists
if not exist "CF-Clearance-Scraper" (
    echo Cloning CF-Clearance-Scraper repository...
    git clone https://github.com/Xewdy444/CF-Clearance-Scraper.git
    if errorlevel 1 (
        echo ERROR: Failed to clone repository!
        pause
        exit /b 1
    )
) else (
    echo CF-Clearance-Scraper directory already exists.
)

REM Install Python dependencies
echo.
echo Installing Python dependencies...
cd CF-Clearance-Scraper
pip install -r requirements.txt
if errorlevel 1 (
    echo ERROR: Failed to install dependencies!
    echo Try running: pip install --upgrade pip
    cd ..
    pause
    exit /b 1
)

cd ..

echo.
echo ============================================
echo CF-Clearance-Scraper installed successfully!
echo ============================================
echo.
echo The bot will now use CF-Clearance-Scraper as the primary method
echo for getting cf_clearance tokens, with CloudFreed as fallback.
echo.
pause