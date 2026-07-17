# Lumi Playwright Extra MCP

This service keeps the official `@playwright/mcp` tool surface while launching
its persistent browser context through `playwright-extra`.

Stealth is enabled by default:

```powershell
node dist/bin/run.mjs --user-data-dir C:\path\to\profile --channel chrome
```

Capture the current Windows and Chrome identity before creating a persistent
Lumi profile. The command stores the captured values as expectations; it does
not spoof the CPU, GPU, user agent, or plugin list.

```powershell
pnpm --filter @proj-airi/playwright-extra-mcp capture-identity -- \
  --output C:\path\to\lumi-browser-profile.json \
  --user-data-dir C:\path\to\profile
```

Use the generated file at runtime:

```powershell
node dist/bin/run.mjs --config C:\path\to\lumi-browser-profile.json
```

The default navigation policy waits for DOM readiness and a short render settle
after navigation. It intentionally avoids fake mouse paths, random fingerprints,
and indiscriminate cookie clearing.

The launcher is intentionally extensible:

- `--plugin <module>` loads another `playwright-extra` compatible plugin.
- `--init-script <path>` installs a Playwright context initialization script.
- `--setup-module <path-or-module>` loads a module exporting `setup(context, config)`.
- `--config <path>` loads the complete JSON configuration.

Example JSON configuration:

```json
{
  "userDataDir": "C:\\path\\to\\profile",
  "browser": {
    "channel": "chrome",
    "headless": false,
    "launchOptions": {}
  },
  "plugins": [
    {
      "module": "puppeteer-extra-plugin-stealth",
      "options": {}
    }
  ],
  "initScripts": [],
  "setupModules": [],
  "mcp": {}
}
```
