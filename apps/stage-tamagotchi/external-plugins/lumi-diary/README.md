# Lumi Diary External Plugin

This is an AIRI external plugin that gives Lumi a Markdown diary.

## Features

- Writes diary entries as local `.md` files.
- Default diary directory: `%USERPROFILE%\Documents\LumiDiary`.
- The diary directory can be configured from `Settings -> Plugins -> Lumi Diary`, or through `lumi_diary_configure`.
- Daily forced diary writing can be enabled from the same settings page. The default suggested time is 23:00.
- Lumi can search diary files by keyword, lightweight vector similarity, or hybrid ranking.
- Lumi can read a specific day or list recent diary files.

## Import

1. Open AIRI desktop.
2. Go to `Settings -> Plugins`.
3. Click `Add Plugin`.
4. Select this directory: `external-plugins/lumi-diary`.
5. Enable and load the plugin.

## Tools

- `lumi_diary_configure`: get or set the diary directory.
- `lumi_diary_write_entry`: write a human-style diary entry.
- `lumi_diary_open_directory`: open the diary directory in the system file manager.
- `lumi_diary_search`: search diary files.
- `lumi_diary_read_day`: read one diary file by date.
- `lumi_diary_list_recent`: list recent diary files.

## Model Guidance

The plugin registers prompt guidance for the chat model. Lumi should write only at meaningful moments, not every routine exchange. The entry should feel like Lumi's private diary, not an event log: feelings, impressions, boundaries, uncertainty, and memory of the day should be written in Lumi's own style.

The plugin does not call a model itself. The currently configured consciousness model decides when to call the tools and composes the diary prose.
