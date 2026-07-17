# Minimal AIRI Tool Plugin

This is a zero-build external plugin template.

## Install

1. Open AIRI desktop.
2. Open `Settings -> Plugins`.
3. Click `Add Plugin`.
4. Select this `minimal-tool-plugin` folder.
5. Enable and load the plugin.

## Files

- `plugin.airi.json`: plugin manifest.
- `index.mjs`: Electron runtime entrypoint.

## Edit

Rename the plugin in `plugin.airi.json`, then edit `index.mjs`.

Keep tool schemas strict:

- `type: "object"`
- `required` includes every property
- `additionalProperties: false`
