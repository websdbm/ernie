import { disabledToolIds, enabledSkillIds } from '@ernie/skills';
import { describe, expect, it } from 'vitest';
import { guardianSettings } from './guardian.js';

describe('new tool guardian boundaries', () => {
  it('does not turn batch reads into a way around the disabled web capability', () => {
    const off = disabledToolIds(guardianSettings({}, ['todo', 'ricette']));
    for (const id of ['web_search', 'web_fetch', 'read_sources', 'youtube_read'])
      expect(off.has(id)).toBe(true);
    expect(disabledToolIds(guardianSettings({}, ['todo', 'web'])).has('read_sources')).toBe(false);
  });
  it('does not grant Todo patch or verification tools to a supervised account without Todo', () => {
    const settings = guardianSettings({}, ['ricordami']);
    expect(enabledSkillIds(settings).has('todo')).toBe(false);
    for (const id of ['todo_get', 'todo_save', 'change_preview', 'change_apply', 'check_result'])
      expect(disabledToolIds(settings).has(id)).toBe(true);
  });
});
