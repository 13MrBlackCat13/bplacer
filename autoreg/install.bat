@echo off
echo Installing Python dependencies for Turnstile Captcha Solver...
cd /d "%~dp0"
python -m pip install -r requirements.txt
echo.
echo Downloading Camoufox browser...
camoufox fetch
echo.
echo Installation complete!
pause