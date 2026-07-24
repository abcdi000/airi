# AstrBot integration

This directory contains Lumi's AstrBot event bridge:

- [`astrbot_plugin_lumi`](./astrbot_plugin_lumi): installable AstrBot plugin.
- Central-server support lives in `packages/lumi-server-runtime`.
- Offline desktop support lives in the stage-tamagotchi local AstrBot gateway.

The plugin is intentionally not an OpenAI-compatible provider. AstrBot receives
platform events and sends message chains. The selected Lumi runtime remains the
only consciousness, memory owner, multimodal perception runtime, tool host, and
reply author.

Two targets are supported:

- `desktop_local`: connects to the running Windows Lumi client on
  `http://127.0.0.1:6132`. The desktop client must be in offline mode, and its
  existing Body Modules configuration supplies consciousness, vision, hearing,
  memory, and MCP.
- `server`: connects to Lumi Server, normally on `http://127.0.0.1:6130`.

Both targets expose the same authenticated AstrBot perception contract, so the
plugin does not duplicate Lumi logic or branch its media pipeline by target.
