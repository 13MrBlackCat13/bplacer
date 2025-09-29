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

