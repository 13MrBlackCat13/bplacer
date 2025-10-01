## Changelog v4.3.11
Enhanced credential import with proxy support, color highlighting in preview, and community contribution templates.

### New Features:
- **Interactive Color Highlighting**: Click on any color in the palette to highlight all pixels of that color on the preview
  - 🟣 Magenta highlight for unplaced pixels (pixels that need to be placed)
  - 🟢 Green highlight for already placed pixels
  - Works on both Add Template page and Manage Templates preview
  - Automatically loads preview when clicking a color if not already visible
  - Click again to deselect and remove highlight
- **GitHub Community Templates**:
  - Added bug report issue template with environment and configuration fields
  - Added feature request template with use case and benefits sections
  - Added CONTRIBUTING.md with development setup, coding guidelines, and testing instructions

### Improvements:
- **Credential Import Enhancements**:
  - Reduced batch size from 6 to 2 concurrent requests to prevent rate limiting
  - Added 15-second delay between batches for better rate limit compliance
  - Enabled automatic proxy rotation for import requests (useProxy: true)
  - Each login request now uses a different proxy for better distribution
- **UI/UX**:
  - Added hover effects on palette color items (border highlight, elevation)
  - Color items now show cursor pointer to indicate clickability
  - Selected colors get blue border with shadow effect
  - Clickable palette items have smooth transitions

### Bug Fixes:
- Fixed `ReferenceError: LAST_USER_STATUS is not defined` error when starting templates
- Created `UserStatusCache` to properly track user droplets and extraColorsBitmap data
- UserStatusCache now updates alongside ChargeCache when loading user info

### Technical Changes:
- Modified `loginWithCredentials()` to accept `useProxy` parameter for proxy rotation
- Added proxy support via `cfClearanceManager.getClearance()` with proxy info
- Frontend now passes `useProxy: true` when importing credentials
- Created new cache system for user status (droplets, color ownership)
- Refactored color highlighting with separate state management
- Added `highlightedColorId` state for both Add Template and Manage Templates pages

## Changelog v4.3.10
Improved heatmap visualization with rainbow gradient, better bulk action error messages, and credentials import.

### New Features:
- Added "Import Credentials (.txt)" button for importing accounts from username:password format
- Credentials import supports format: "username:password" (one per line)
- Automatic deduplication based on existing usernames
- Parallel import with progress tracking (6 concurrent requests)
- Detailed summary with success/failure counts and error messages

### Improvements:
- Enhanced heatmap with rainbow-like color gradient (red to blue)
- Newest pixels now show in red, gradually transitioning to blue for older pixels
- Added alpha fade for older pixels to improve visual clarity
- Applied gradient to both fit and zoom heatmap modes
- Improved alliance join error messages (409 now returns "User is currently active")
- Added automatic retry logic for bulk actions when users are temporarily busy (409 errors)
- Bulk actions now retry up to 3 times with 2-second delays before marking as failed
- Progress indicator shows retry attempts during bulk operations

### Bug Fixes:
- Fixed bulk alliance join showing generic "Conflict" instead of detailed error message

### Credits:
- Heatmap improvements based on PR #2 by DaCrazyRaccoon with enhancements

## Changelog v4.3.9
Critical fix for bot getting stuck on accounts without premium colors.

### Bug Fixes:
- Fixed bot getting stuck on accounts without premium colors and insufficient droplets to buy them
- Bot now skips users who lack needed premium colors AND cannot afford to purchase them (2000 droplets + reserve)
- Prevents infinite loop when all accounts have charges but none can paint premium pixels

### Technical Changes:
- Added premium color ownership check in user queue selection algorithm
- Queue now validates users can paint before selecting them (checks color ownership and droplet balance)
- Users without needed colors and insufficient funds are now skipped in queue rotation

## Changelog v4.3.8
Improved bulk actions with detailed error reporting and automatic field validation.

### Improvements:
- Added detailed error reporting for all bulk actions (Join Alliance, Set Discord, Enable/Disable Show Last Pixel)
- Bulk actions now display user names in progress instead of just IDs
- Failed operations now show scrollable list with specific error messages and status codes
- Automatic truncation of name and discord fields to 15 characters (bplace.org API limit)
- Prevents 400 errors caused by auto-generated usernames exceeding character limits

### Bug Fixes:
- Fixed ReferenceError in bulk actions by properly loading user data before processing
- Fixed "Name must be at most 15 characters" errors for auto-generated usernames
- Improved error handling with detailed failure reasons for each user
- Fixed Colors page showing incorrect ownership data due to 32-bit truncation of extraColorsBitmap
- Premium colors 32-95 now display correct owner lists instead of "Nobody has this color yet"

### Technical Changes:
- All bulk action functions now load user data via GET /users before processing
- Added 100ms delay between bulk requests to prevent UI overwhelming
- Improved progress indicators showing current user being processed
- Server-side automatic field truncation for name and discord fields
- Replaced all bitwise OR operations (| 0) on extraColorsBitmap with string fallback (|| "0")
- Prevents 32-bit truncation that caused loss of premium color data for colors 64-95

## Changelog v4.3.7
Bug fixes and performance improvements for color handling and Cloudflare challenge detection.

### Bug Fixes:
- Fixed hasColor() method to properly support premium colors 64-95 using BigInt operations
- Premium colors in the upper range (64-95) now correctly detected for ownership checks
- Prevents bot from attempting to paint pixels with colors the account doesn't own

### Performance Improvements:
- Added caching for "No Cloudflare challenge detected" state (1 hour TTL)
- Significantly reduced Python scraper invocations when no CF challenge is present
- First request now gets cached result if no challenge exists, avoiding redundant scraper calls
- Python scraper only runs when actual Cloudflare block is detected (403/502/503)

### Technical Changes:
- Updated CF-Clearance manager to cache negative challenge detection results
- Modified MockImpit.fetch() to handle cached "no challenge" state properly
- Improved retry logic to check for challenge state before invoking scraper

## Changelog v4.3.6 - NEEDS TESTING
Major improvements to proxy system and Cloudflare handling. Extensive testing required.

### New Features:
- Implemented centralized HTTP client with automatic Cloudflare challenge detection
- Added CF-Clearance token management with 23-hour caching
- Integrated proxy support for all bplace.org API interactions (tiles, pixels, colors, flags, user info)
- Added automatic credential-based account registration system with Turnstile captcha solving
- Created batch registration API with proxy rotation support

### Improvements:
- Cookies are now included in loadTiles requests to prevent Cloudflare blocks during pixel checking
- Added automatic fallback: works without CF-Clearance if no challenge is detected, obtains token on first block
- Improved proxy URL building in registration system
- Enhanced error handling for rate limiting (429 errors) in registration
- Added detailed logging for CF-Clearance operations and debugging

### Technical Changes:
- Proxy selection now integrated into WPlacer login flow
- All POST requests (paint, buyColor, equipFlag) now use centralized browser.fetch with CF support
- CF-Clearance tokens automatically refresh when expired or blocked
- Added registration guide documentation (REGISTRATION_GUIDE.md)
- Created autoreg Python toolkit for batch account creation

### Known Issues:
- System requires extensive testing due to multiple new integrations
- Rate limiting may occur during batch registration operations
- CF-Clearance-Scraper dependency needs proper setup

**IMPORTANT**: This build contains significant changes to core networking. Test thoroughly before production use.

## Changelog v4.3.5
- Revert to last workable version. Update if you have troubles.
- Added export jwt tokens feature. Thanks to [Almossr](https://github.com/ZypherFF)!

## Changelog v4.3.1
- Added auto-open browser after program starts
- Added security warning for HOST=0.0.0.0 with recommendations to use 127.0.0.1


## Changelog v4.3.0
- Added Flags section. Full functionality for purchasing/equipping needed flags.
- Added auto-start template setting when program launches.
- Added ability to configure automatic page reload every X seconds or disable it in the extension. Does not affect reloads requested by server during painting.


## Changelog v4.2.9
- Added exclusion of restricted/banned users from the template list.
- Moved log settings out of general settings into Live Logs.
- Added estimated time left info on template & fix host value env that was unused (Thanks to [Aglglg](https://github.com/Aglglg)).
- Added queue preview system feature. Thanks to [lulz](https://github.com/Udyz)!
- Added recognition for a banned accounts in the status check.
- Minor fixes and painting improvements (bursts).


## Changelog v4.2.8 – Quick Fixes
- Added bulk “Buy paint charges (All)” action: buys pixel charges for all accounts using available droplets while honoring the configured droplet reserve and purchase cooldown. Includes a progress display and a result summary.
- Added a Live Logs section with an option to hide sensitive information.
- Fixed auto‑buying of charges during painting.
- Added automatic activation of inactive tiles during painting (places 1 pixel to activate, then retries).
- Added import of JWT tokens (.txt file). Thanks for the feature, Chris (@leachit)!
- Added several features and improvements from pull requests (including Skip Painted Pixels and Outline Mode). Thanks to [lulz](https://github.com/Udyz), [SeiRruf Wilde](https://github.com/SeiRruf), and [Hayden Andreyka](https://github.com/Technoguyfication)!
- Miscellaneous improvements.
Note: Many other bugs and issues are known; unfortunately, there isn’t much time right now to fix everything. Fixes and improvements will be made as time permits, and there are also several ideas planned for future implementation.


## Changelog v4.2.6-4.2.7
- Added an "Active/Expired accounts" table shown after the status check (you can remove non‑working accounts with one click).
- Added an extension that automates account re‑login. See the AutoLogin README: [WPlace AutoLogin — Chrome Extension](https://github.com/lllexxa/wplacer/blob/main/Wplacer-AutoLogin-Profiles/README.md)


## Changelog v4.2.5 QUICK FIX
- Fixed extension!
- Added automatic Cloudflare Turnstile solving!
- Works on Chrome-based browsers (not tested on others). Re-upload the extension to your browser!
Known issues: If you constantly see `❌ Background resync finished (error)` on an account while template is running, you should re‑login (refresh cookies). HTTP 401 can appear occasionally and usually does not break the flow, but I cannot fully fix it yet. Please remember this build is unstable.
Recommendation: keep a `bplace.org` tab focused (active) while running to avoid throttling and ensure stable token acquisition.


## Changelog v4.2.4
- Proxy: improved proxy handling; blocking proxies are now quarantined for 20 minutes.
- Proxy: added a settings option to validate proxies and remove non‑working ones (note: some proxies may work intermittently).
- Logging: added log category toggles in `settings.json` — you can disable noisy categories (e.g., `queuePreview`, `drawingMode`, `startTurn`, `mismatches`).


## Changelog v4.2.3
- Fixed extension behavior.
- You need to reload the extension in your browser (refresh it in chrome://extensions or reinstall it).


## Changelog v4.2.2
- Front-End improvements:
  - Added a counter to the palette header: “Remaining colors” now shows the total number of remaining pixels.
  - Added a “Refresh canvas” button in the preview. Clicking it reloads the visible area.
  - Added an overlay pixel scale slider (50–100%).
  - When “Stop” is pressed, the template now stops right after the current request to a single tile (fixed).
  - Heatmap: fixed and optimized (You can also now enable and configure this in the template settings).
  - Fixed preserving user checkboxes when opening a template and when changing the user sort order.
  - Added a progress counter to “Check Account Status”.
  
Note: The next update will focus on fixing drawing modes, improving template rendering with premium colors, and addressing other core issues. As this is a fork, occasional instability is expected.


## Changelog v4.2.1
- Fixed an issue with alternating "Painted // Token expired/invalid" during drawing.
- Added custom labeling for accounts (e.g., account email or browser profile) to facilitate easier navigation and management when refreshing cookies. Check "Edit User" section.
- Updated extension (re-upload in your browser)
- Added warnings:
  - Added a warning box before 'Check Account Status' when Account Check Cooldown equals 0.
  - Added a warning box before 'Start Template' when Account Turn Cooldown equals 0.


## Changelog v4.2.0
- Trying to fix token issue
- Heatmap preview added


## Changelog v4.1.9
- Fixed cooldown handling so settings-based delays are respected between all parallel requests (cache warm-up, keep-alive, colors check, purchases) both with and without proxies, and added a proxy concurrency setting to control the number of parallel workers (except drawing).
- Active bar: added per-template Preview button and progress bar.
- Manage Users: total charges now shown as X/Y pixels.
- Regen Speed: fixed.
- Add/Edit Template: sorting by available charges added; shows X/max near drops.
- Token wait notice: after 1 minute without token, show hint to reload extension (Cloudflare Turnstile 300030).


## Changelog v4.1.8
- Added support for multiple proxy formats (parsing and usage):
  - http(s)://user:pass@host:port, socks4://..., socks5://...
  - user:pass@host:port (supports [ipv6])
  - \[ipv6]:port
  - host:port
  - user:pass:host:port
  - Inline comments in data/proxies.txt via `#` or `//` are ignored
- Fixed the issue with stretched images in previews.
- 401/403 errors now take up less space in terminal.


## Changelog v4.1.7 HARD-CODE FIX OF THE DRAWING
- Re-upload the extension to your browser!

## Changelog v4.1.6
Reminder: If drawing stops, inspect console logs in bplace.org for Turnstile errors (or set the pixel manually). If it’s a Turnstile issue, restart your browser or log in via incognito/another browser or profile.

- Added pin/unpin templates at the top of the page.
- Added per-color pixel preview with remaining counts.
- Made cache warm-up parallel when proxies are enabled.
- Improved cookie keep-alive checks with parallel execution when proxies are enabled.
- Made “Check Colors (All), Check Account Status, Attempt to Buy for Selected, Buy Max Charge Upgrades (All)” run faster with proxies.
- Added a color purchase and max charge upgrades counters.
- Frontend now uses proxies (if enabled) to fetch tiles for previews.
- Fixed CSS of the bulk color purchase info window.
- Default sort now ranks users with the template’s required premium colors first, auto-updating on upload, toggle, and edit.
- Added a button to leave the alliance.
- Added a warning when account cooldown is set to 0 with proxies disabled.
- Automated cords parsing on paste.
- Added a 'Changelog' button to the Dashboard that opens the existing changelog.
- Added statistics fields: Total Droplets and Regen Speed.

If you see your problem in the fix list but it still exists, please report it in the main WPlacer Discord server, and make sure to indicate that you are using the fork to avoid misunderstandings.


## Changelog v4.1.5 (FIX DRAWING)
- Re-upload the extension to your browser!
- Also, in the account settings, I added the option to join the alliance by its UUID (taken from the joining link) 
P.S. Various other bugs are known and will be fixed when there is time (auto-purchase of colors and others)
Thanks for fix them @!Protonn @[Sleeping] Chris @rogu3anuerz2 @lulu


## Changelog v4.1.4
- Quick temporary solution for stable core drawing mechanics (Note: re-upload browser extension also).


## Changelog v4.1.3
- Quick improvement of user sorting


## Changelog v4.1.2

- Drawing modes: new "Inside Out" (center → edges) mode
- Manage Users: profile editor (Name / Discord / Show last pixel)
- Colors: section to view owners and manually buy needed premium colors
- Add/Edit Template: color palette and user sorting during assignment
- Auto‑purchases: optional automatic purchase of premium colors
- Settings: "Max pixels per pass" option
- Full‑screen preview: correct handling of transparent pixels and mismatch logic
- UI improvements
- One‑time disclaimer modal; version check with remote changelog

