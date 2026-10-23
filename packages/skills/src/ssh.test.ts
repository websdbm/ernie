import { describe, expect, it } from 'vitest';
import { disabledToolIds, enabledSkillIds } from './catalog.js';
import { createSshSkill, requiresSshModel } from './ssh.js';

describe('SSH activation and advanced routing', () => {
  it('is off until explicitly available and enabled', () => {
    expect(enabledSkillIds({}).has('ssh')).toBe(false);
    expect(enabledSkillIds({ skills: { ssh: true } }).has('ssh')).toBe(true);
    expect(
      enabledSkillIds({ skills: { ssh: true }, skillsAvailable: { ssh: false } }).has('ssh'),
    ).toBe(false);
    expect(disabledToolIds({}).has('ssh_plan')).toBe(true);
    expect(createSshSkill().riskClass).toBe('high');
  });
  it('requires advanced model for infrastructure and its follow-up, keeps ordinary chat unaffected', () => {
    expect(requiresSshModel('controlla Docker sul server', null)).toBe(true);
    expect(requiresSshModel('fallo', null, ['utente: controlla il server'])).toBe(true);
    expect(requiresSshModel('controlla example.it', 'ssh')).toBe(true);
    expect(requiresSshModel('example.it non risponde', null)).toBe(true);
    expect(requiresSshModel('errore 502 su https://example.it', null)).toBe(true);
    expect(requiresSshModel('Approfondisci la diagnosi', null, ['example.it non risponde'])).toBe(
      true,
    );
    expect(requiresSshModel('riassumi https://example.it', null)).toBe(false);
    expect(requiresSshModel('fammi i muffin', null)).toBe(false);
  });
});
