import { describe, expect, it } from 'vitest';
import { argsHash, PendingApprovals } from './approvals.js';
import { COMMANDS_HELP, routeCommand } from './commands.js';
import { StuckDetector } from './loop.js';
import { evaluateToolPolicy, RunContext, type ToolPolicyDescriptor } from './policy.js';

const read: ToolPolicyDescriptor = {
  id: 'shopping_list.read',
  risk: { readsPrivate: true, ingestsUntrusted: false, externalEffect: false, write: false },
};
const add: ToolPolicyDescriptor = {
  id: 'shopping_list.add',
  risk: { readsPrivate: true, ingestsUntrusted: false, externalEffect: false, write: true },
};
const web: ToolPolicyDescriptor = {
  id: 'web_search',
  risk: { readsPrivate: false, ingestsUntrusted: true, externalEffect: false, write: false },
};
const send: ToolPolicyDescriptor = {
  id: 'email.send',
  risk: { readsPrivate: true, ingestsUntrusted: false, externalEffect: true, write: false },
  requiredScopes: ['email'],
};

describe('evaluateToolPolicy', () => {
  it('fail-closed: tool sconosciuto → deny; scope mancante → deny', () => {
    const ctx = new RunContext('u', ['chat'], 0).toPolicyContext();
    expect(evaluateToolPolicy(undefined, ctx).kind).toBe('deny');
    expect(evaluateToolPolicy(send, ctx).kind).toBe('deny');
    expect(evaluateToolPolicy(send, { ...ctx, scopes: ['chat', 'email'] }).kind).toBe('allow');
  });

  it('Rule of Two: dopo contenuto non fidato, scritture ed effetti esterni → ask', () => {
    const run = new RunContext('u', ['chat', 'email'], 0.1);
    expect(evaluateToolPolicy(add, run.toPolicyContext()).kind).toBe('allow');
    run.markUntrusted('web_search:https://example.com');
    expect(run.tainted).toBe(true);
    expect(evaluateToolPolicy(add, run.toPolicyContext())).toEqual({
      kind: 'ask',
      reason: expect.stringContaining('Rule of Two'),
    });
    expect(evaluateToolPolicy(send, run.toPolicyContext()).kind).toBe('ask');
    expect(evaluateToolPolicy(read, run.toPolicyContext()).kind).toBe('allow');
    expect(evaluateToolPolicy(web, run.toPolicyContext()).kind).toBe('allow');
  });

  it('egress: con contenuto non fidato e dati privati nella run, ricerca e fetch chiedono conferma', () => {
    const search: ToolPolicyDescriptor = { ...web, risk: { ...web.risk, egress: true } };
    const run = new RunContext('u', ['chat'], 0);
    expect(evaluateToolPolicy(search, run.toPolicyContext()).kind).toBe('allow');
    run.markUntrusted('web:https://example.com');
    expect(evaluateToolPolicy(search, run.toPolicyContext()).kind).toBe('allow'); // navigare resta libero
    run.markPrivateRead('shopping_list_get');
    const v = evaluateToolPolicy(search, run.toPolicyContext());
    expect(v.kind).toBe('ask');
    expect(v.kind === 'ask' && v.reason).toContain('fuga di dati');
    // Senza egress (lettura locale) la combinazione non blocca; senza taint neppure.
    expect(evaluateToolPolicy(read, run.toPolicyContext()).kind).toBe('allow');
    const clean = new RunContext('u', ['chat'], 0);
    clean.markPrivateRead('memory_search');
    expect(evaluateToolPolicy(search, clean.toPolicyContext()).kind).toBe('allow');
    expect(run.privateSources).toEqual(['shopping_list_get']);
  });

  it('il segnale di rischio del router può solo restringere; denyTools e alwaysAsk', () => {
    const risky = new RunContext('u', ['chat', 'email'], 0.9).toPolicyContext();
    expect(evaluateToolPolicy(send, risky).kind).toBe('ask');
    expect(evaluateToolPolicy(add, risky).kind).toBe('allow');
    expect(evaluateToolPolicy(add, risky, { denyTools: ['shopping_list.add'] }).kind).toBe('deny');
    expect(evaluateToolPolicy(read, risky, { alwaysAsk: ['shopping_list.read'] }).kind).toBe('ask');
  });
});

describe('approvals', () => {
  it("argsHash è stabile rispetto all'ordine delle chiavi", () => {
    expect(argsHash({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(
      argsHash({ b: [1, { d: 3, c: 2 }], a: 1 }),
    );
    expect(argsHash({ a: 1 })).not.toBe(argsHash({ a: 2 }));
  });

  it('PendingApprovals risolve, scade e si annulla', async () => {
    const p = new PendingApprovals();
    const w = p.wait('x', 1000);
    expect(p.settle('x', 'approved')).toBe(true);
    expect(await w).toBe('approved');
    expect(p.settle('x', 'approved')).toBe(false);
    expect(await p.wait('y', 10)).toBe('expired');
    const ac = new AbortController();
    const z = p.wait('z', 1000, ac.signal);
    ac.abort();
    expect(await z).toBe('denied');
    expect(p.size).toBe(0);
  });
});

describe('routeCommand', () => {
  const ctx = {
    companionName: 'Ernie',
    modelClass: 'standard' as const,
    contextTags: [],
    spentTodayUsd: 0.0123,
    budgetUsd: 2,
    role: 'owner' as const,
  };

  it('riconosce i comandi e ignora il testo libero', () => {
    expect(routeCommand('ciao', ctx)).toEqual({ kind: 'none' });
    expect(routeCommand('/aiuto', ctx)).toEqual({
      kind: 'reply',
      text: `Comandi di Ernie:\n${COMMANDS_HELP}`,
    });
    const stato = routeCommand('/stato', ctx);
    expect(stato.kind).toBe('reply');
    if (stato.kind === 'reply') expect(stato.text).toContain('0.0123 di 2.00 USD');
    expect(routeCommand('/boh', ctx).kind).toBe('reply');
  });

  it('la classe si sceglie a mano in tutte e due le direzioni; i contesti sono validati', () => {
    expect(routeCommand('/classe heavy', ctx)).toEqual({
      kind: 'set_class',
      modelClass: 'heavy',
      text: expect.any(String),
    });
    expect(routeCommand('/classe standard', ctx).kind).toBe('reply');
    expect(routeCommand('/classe light', ctx).kind).toBe('reply');
    // heavy raggiunto da solo: «/classe heavy» lo rende fisso; «/classe standard» lo riporta giù.
    expect(routeCommand('/classe heavy', { ...ctx, modelClass: 'heavy' }).kind).toBe('set_class');
    expect(routeCommand('/classe standard', { ...ctx, modelClass: 'heavy' })).toEqual({
      kind: 'set_class',
      modelClass: 'standard',
      text: expect.any(String),
    });
    expect(routeCommand('/contesto Cucina spesa', ctx)).toEqual({
      kind: 'set_context',
      tags: ['cucina', 'spesa'],
      text: expect.any(String),
    });
    expect(routeCommand('/contesto nessuno', ctx)).toEqual({
      kind: 'set_context',
      tags: [],
      text: expect.any(String),
    });
    expect(routeCommand('/contesto a!b', ctx).kind).toBe('reply');
  });
});

describe('StuckDetector', () => {
  it('segnala la ripetizione della stessa chiamata e tollera il polling', () => {
    const d = new StuckDetector(2, 4);
    expect(d.check('web_search', { q: 'a' })).toBe('ok');
    expect(d.check('web_search', { q: 'a' })).toBe('ok');
    expect(d.check('web_search', { q: 'a' })).toBe('stuck');
    expect(d.check('web_search', { q: 'b' })).toBe('ok');
    for (let i = 0; i < 4; i++) expect(d.check('job.status', { id: 1 })).toBe('ok');
    expect(d.check('job.status', { id: 1 })).toBe('stuck');
  });
});
