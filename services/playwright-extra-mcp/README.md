# Lumi Browser MCP

This service preserves the official `@playwright/mcp` tool surface while
selecting the browser driver behind a Lumi-owned backend interface.

- Patchright is the default for long-lived Chromium sessions.
- Playwright remains available for Firefox, WebKit, Console, Tracing, explicit
  platform overrides, and compatibility fallback.
- Both backends reuse the same page policies, MCP tools, and persistent profile.

## Default Configuration

The launcher uses the repository's existing JSON and environment configuration
system. Its defaults are equivalent to:

```json
{
  "userDataDir": "data/browser_profiles/lumi",
  "browser": {
    "defaultBackend": "patchright",
    "fallbackBackend": "playwright",
    "platformOverrides": {},
    "patchright": {
      "browserName": "chromium",
      "channel": "chrome",
      "headless": false,
      "persistentContext": true,
      "noViewport": true,
      "launchOptions": {}
    },
    "playwright": {
      "browserName": "chromium",
      "channel": "chrome",
      "headless": false,
      "persistentContext": true,
      "noViewport": true,
      "launchOptions": {}
    }
  },
  "plugins": [],
  "initScripts": [],
  "setupModules": [],
  "mcp": {}
}
```

`LUMI_BROWSER_PROFILE_PATH` overrides the profile directory. The legacy
`LUMI_PLAYWRIGHT_USER_DATA_DIR` variable is still read so an existing Lumi
browser identity is not moved or discarded.

## Selecting A Backend

Selection order is:

1. `--backend patchright|playwright` or `LUMI_BROWSER_BACKEND`
2. `browser.platformOverrides[platform]`
3. Firefox, WebKit, Console, or Tracing requirements select Playwright
4. `browser.defaultBackend`

Examples:

```powershell
# One run with Playwright
node dist/bin/run.mjs --backend playwright

# One platform override from a JSON config
node dist/bin/run.mjs --config C:\path\to\lumi-browser.json --platform xiaohongshu
```

```json
{
  "browser": {
    "defaultBackend": "patchright",
    "fallbackBackend": "playwright",
    "platformOverrides": {
      "some_platform": "playwright"
    }
  }
}
```

Patchright headless mode is supported when explicitly configured, but Lumi logs
a warning because a headed persistent Chrome profile is the recommended setup.

## Compatibility Fallback

Fallback is only allowed from Patchright to Playwright after a classified
compatibility failure:

- Patchright is unavailable.
- The browser executable or supported channel is unavailable.
- Patchright cannot launch a compatible browser or protocol.
- A requested browser or capability is not implemented by Patchright.

Network timeouts, HTTP errors, expired login, CAPTCHA, account restrictions,
missing elements, and business errors never switch backends.

## Browser Installation

The packaged Lumi dependency includes both driver libraries. Development
machines that use a bundled browser instead of the configured system Chrome can
install the matching browser explicitly:

```powershell
pnpm --filter @proj-airi/playwright-extra-mcp exec patchright install chromium
pnpm --filter @proj-airi/playwright-extra-mcp exec playwright install chromium
```

These commands are documentation only; the build does not perform a system
browser installation automatically.

## Identity And Extension Hooks

Capture the current Windows and Chrome identity before creating a persistent
Lumi profile:

```powershell
pnpm --filter @proj-airi/playwright-extra-mcp capture-identity -- `
  --output C:\path\to\lumi-browser-profile.json `
  --user-data-dir C:\path\to\profile
```

The command records expectations and does not spoof the CPU, GPU, user agent, or
plugin list.

- `--plugin <module>` loads a `playwright-extra` plugin when Playwright Chromium
  is selected.
- `--init-script <path>` installs a shared context initialization script.
- `--setup-module <path-or-module>` loads `setup(context, config)`.
- `--config <path>` loads the complete JSON configuration.
