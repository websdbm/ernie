import { describe, expect, it } from 'vitest';
import { disabledToolIds, enabledSkillIds } from './catalog.js';
import { createRaindropSkill, RAINDROP_TOOLS } from './raindrop.js';
import { SkillRegistry } from './registry.js';

describe('Raindrop opt-in skill', () => {
  it('is isolated, off by default and available only for the enabled account', () => {
    expect(enabledSkillIds({}).has('raindrop')).toBe(false);
    expect(enabledSkillIds({ skills: { raindrop: true } }).has('raindrop')).toBe(true);
    expect(
      enabledSkillIds({ skillsAvailable: { raindrop: false }, skills: { raindrop: true } }).has(
        'raindrop',
      ),
    ).toBe(false);
    for (const id of RAINDROP_TOOLS) expect(disabledToolIds({}).has(id)).toBe(true);
    const skill = createRaindropSkill();
    expect(skill.allowedTools).not.toContain('brain_write');
    expect(skill.allowedTools).not.toContain('memory_search');
    expect(skill.instructions).toContain('richiesta esplicita');
    const registry = new SkillRegistry().register(skill);
    expect(registry.candidates('cerca in Raindrop un segnalibro sugli agenti')).toContain(
      'raindrop',
    );
  });
});
