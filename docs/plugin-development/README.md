# AIRI Plugin Development

External plugin development documents:

- [External Plugin Development Specification](./EXTERNAL_PLUGIN_DEVELOPMENT.md)
- [外置插件开发规范](./EXTERNAL_PLUGIN_DEVELOPMENT.zh-CN.md)
- [Minimal tool plugin template](./templates/minimal-tool-plugin)

The current desktop import flow is:

1. Open AIRI desktop.
2. Open `Settings -> Plugins`.
3. Click `Add Plugin`.
4. Select a directory containing `plugin.airi.json`.
5. Enable and load the plugin.

For local development, copy `templates/minimal-tool-plugin` and edit `index.mjs`.
