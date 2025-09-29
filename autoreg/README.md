# Turnstile Captcha Solver API

This is an automatic Turnstile captcha solver API that runs alongside the main bplacer server to enable auto-registration.

## Installation

1. Install Python dependencies:
   ```bash
   cd autoreg
   python -m pip install -r requirements.txt
   ```

   Or run:
   ```bash
   install.bat
   ```

## Required Dependencies

- fastapi >= 0.115.0
- uvicorn >= 0.32.0
- loguru >= 0.7.2
- camoufox >= 0.4.4
- requests >= 2.32.0

## Usage

### Automatic Start (Recommended)

The captcha API will automatically start when you run the main Node.js server:

```bash
node server.js
```

The API will be available at `http://localhost:8080`

### Manual Start

If you need to run it separately:

```bash
cd autoreg
python api_server.py
```

Or use the batch file:
```bash
start-api.bat
```

## How It Works

1. The API receives captcha solving requests from the main server
2. It uses Camoufox browser to automatically solve Cloudflare Turnstile captchas
3. Returns the captcha token which is then used for registration

## Configuration

The API server is configured in `api_server.py`:
- **Host**: 0.0.0.0
- **Port**: 8080
- **Headless mode**: True
- **Thread count**: 5
- **Page count per thread**: 1

## Troubleshooting

If the API fails to start:
1. Make sure Python is installed and in PATH
2. Install dependencies: `pip install -r requirements.txt`
3. Check that port 8080 is not already in use
4. Check the console output for error messages

If captcha solving is slow:
- Increase thread count in `api_server.py` (line 290)
- Increase page count per thread (line 291)
- Note: More threads/pages = more memory usage