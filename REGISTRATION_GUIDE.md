# Auto-Registration Guide

## Overview

The auto-registration system allows you to automatically create bplace.org accounts with:
- ✅ Automatic Turnstile captcha solving
- ✅ Proxy rotation (each account uses different proxy)
- ✅ CF-Clearance token management
- ✅ User-Agent consistency (same UA for CF-Clearance and all requests)

## How It Works

### 1. Proxy Rotation
- Each registration uses the next proxy from `data/proxies.txt`
- The same proxy is used for:
  - Getting CF-Clearance token
  - Loading login page
  - Solving captcha
  - Submitting registration
- Next registration will use the next proxy (round-robin)

### 2. CF-Clearance Flow
```
Registration #1 → Proxy #1 → Get CF-Clearance with Proxy #1 → Use same proxy for all requests
Registration #2 → Proxy #2 → Get CF-Clearance with Proxy #2 → Use same proxy for all requests
Registration #3 → Proxy #3 → Get CF-Clearance with Proxy #3 → Use same proxy for all requests
...
```

### 3. User-Agent Handling
- CF-Clearance-Scraper generates a random User-Agent when getting the token
- This User-Agent is saved in the cache along with the token
- All subsequent requests use the SAME User-Agent that was used to get CF-Clearance
- This ensures consistency and avoids detection

## Setup

### 1. Add Proxies
Add proxies to `data/proxies.txt` (one per line):
```
socks5://username:password@host:port
socks5://username:password@host:port
...
```

### 2. Enable Proxies
In the web UI, go to Settings and enable "Use proxies"

### 3. Install Captcha Solver Dependencies
```bash
cd autoreg
install.bat
```

Or manually:
```bash
pip install -r requirements.txt
camoufox fetch
```

## Usage

### Web UI
1. Open the web UI
2. Click "Add Account" → "Register New Account"
3. Enter username and password
4. The system will:
   - Select next proxy
   - Get CF-Clearance with that proxy
   - Solve captcha
   - Register account
   - Save JWT token

### API Endpoint
```bash
POST /register-account
Content-Type: application/json

{
  "username": "user123",
  "password": "pass123"
}
```

Response (success):
```json
{
  "success": true,
  "username": "user123",
  "cookies": {
    "j": "eyJhbGci...",
    "cf_clearance": "..."
  }
}
```

## Technical Details

### Proxy Format
The system automatically parses proxies in the format:
```
protocol://username:password@host:port
```

Supported protocols:
- `socks5://`
- `socks4://`
- `http://`
- `https://`

### CF-Clearance Cache
CF-Clearance tokens are cached with the format:
```
{proxyType}:{userId}
```

Example:
- `socks5:127.0.0.1:1080:register_1759180500981`

This ensures each proxy+user combination has its own token.

### Rate Limiting
- 5 second delay after captcha solving before submission
- Proxy rotation helps avoid IP-based rate limiting
- If you get 429 errors, wait a few minutes or add more proxies

## Troubleshooting

### "No proxies available"
- Add proxies to `data/proxies.txt`
- Enable proxies in Settings

### "Failed to get cf_clearance"
- Check CF-Clearance-Scraper is working: `cd CF-Clearance-Scraper && python main.py https://bplace.org`
- Try different proxies (some may be blocked)

### "Captcha solver not running"
- Start the API: `cd autoreg && python api_server.py`
- Or let it auto-start with the main server

### "Too many requests (429)"
- Wait 5-10 minutes
- Add more proxies
- The system uses proxy rotation to avoid this

## Example Flow

```
User clicks "Register New Account" with username "user123"
  ↓
System selects Proxy #5: socks5://gozpujwo:***@45.151.161.78:6169
  ↓
CF-Clearance-Scraper runs through Proxy #5
  → Returns: cf_clearance token + User-Agent
  ↓
MockImpit initialized with:
  - proxyUrl: socks5://gozpujwo:***@45.151.161.78:6169
  - cf_clearance: ya9vuuNHl...
  - userAgent: Mozilla/5.0 (X11; Linux x86_64)...
  ↓
GET https://bplace.org/login (through Proxy #5, with cf_clearance + UA)
  ↓
Solve Turnstile captcha
  ↓
Wait 5 seconds
  ↓
POST https://bplace.org/account/register (through Proxy #5, with cf_clearance + UA + captcha token)
  ↓
Success! JWT token received
  ↓
Next registration will use Proxy #6
```

## Notes

- Each account gets a unique proxy
- Proxies are rotated in round-robin fashion
- CF-Clearance tokens are cached per proxy
- User-Agents are consistent throughout the registration flow
- The system automatically restarts captcha API on server start