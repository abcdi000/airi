import { describe, expect, it } from 'vitest'

import { appNamesMatch, canonicalizeKnownAppName, findKnownAppMention, getKnownAppLaunchNames, normalizeAppAction } from './app-aliases'

describe('app aliases', () => {
  it('matches VS Code aliases to Visual Studio Code', () => {
    expect(appNamesMatch('VS Code', 'Visual Studio Code')).toBe(true)
    expect(appNamesMatch('vscode', 'Visual Studio Code')).toBe(true)
    expect(appNamesMatch('Visual Studio Code for mac', 'Visual Studio Code')).toBe(true)
    expect(canonicalizeKnownAppName('VS Code')).toBe('Visual Studio Code')
    expect(getKnownAppLaunchNames('VS Code')).toContain('Visual Studio Code for mac')
  })

  it('normalizes open_app actions to a known canonical app name', () => {
    expect(normalizeAppAction({
      kind: 'open_app',
      input: { app: 'VS Code' },
    })).toEqual({
      kind: 'open_app',
      input: { app: 'Visual Studio Code' },
    })
  })

  it('keeps unknown application names available to the executor', () => {
    expect(normalizeAppAction({
      kind: 'focus_app',
      input: { app: 'Notepad++' },
    })).toEqual({
      kind: 'focus_app',
      input: { app: 'Notepad++' },
    })
  })

  it('finds known app mentions in workflow labels', () => {
    expect(findKnownAppMention('Open project in VS Code')).toBe('Visual Studio Code')
    expect(findKnownAppMention('Reveal folder in Finder')).toBe('Finder')
  })
})
