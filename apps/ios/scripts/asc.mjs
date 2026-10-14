#!/usr/bin/env node
/**
 * App Store Connect via API con la chiave ASC (JWT ES256), senza Xcode né browser.
 *   node apps/ios/scripts/asc.mjs groups                      elenca i gruppi TestFlight dell'app
 *   node apps/ios/scripts/asc.mjs invite <email> <nome> <cognome> [ruolo]   invita un membro del team (default CUSTOMER_SUPPORT) con accesso alla sola app Ernie
 *   node apps/ios/scripts/asc.mjs add-internal <email> <gruppo>             aggiunge un utente del team (già accettato) al gruppo interno
 *   node apps/ios/scripts/asc.mjs uninvite <email>                          ritira un invito non ancora accettato (per rifarlo con dati corretti)
 *   node apps/ios/scripts/asc.mjs testers <gruppo>                          elenca i tester di un gruppo
 *   node apps/ios/scripts/asc.mjs devices                                   dispositivi registrati (per build ad hoc)
 *   node apps/ios/scripts/asc.mjs device <nome> <udid>                      registra un iPhone per le build ad hoc (es. l'iPhone di un familiare)
 *   node apps/ios/scripts/asc.mjs bundles                                   App ID registrati (com.websdbm.ernie*) con le capability
 *   node apps/ios/scripts/asc.mjs app-groups <identifier> [nome]            registra l'App ID se manca e abilita la capability App Groups
 *   node apps/ios/scripts/asc.mjs whats-new <build> [--wait]                scrive «Cosa testare» (TestFlight) dalla voce della build in Ernie/Resources/Changelog.json
 * Variabili: ASC_KEY_ID (default APWGU2N593), ASC_ISSUER_ID, ASC_KEY_PATH (~/.appstoreconnect/private_keys/AuthKey_<id>.p8), ASC_APP_ID (default 6821598639).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSign } from 'node:crypto';
import { homedir } from 'node:os';

const keyId = process.env.ASC_KEY_ID ?? 'APWGU2N593';
const issuer = process.env.ASC_ISSUER_ID ?? '69a6de73-38d3-47e3-e053-5b8c7c11a4d1';
const appId = process.env.ASC_APP_ID ?? '6821598639';
const keyPath = process.env.ASC_KEY_PATH ?? `${homedir()}/.appstoreconnect/private_keys/AuthKey_${keyId}.p8`;

function jwt() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'ES256', kid: keyId, typ: 'JWT' });
  const body = b64({ iss: issuer, iat: now, exp: now + 15 * 60, aud: 'appstoreconnect-v1' });
  const sig = createSign('sha256').update(`${head}.${body}`).sign({ key: readFileSync(keyPath, 'utf8'), dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${sig.toString('base64url')}`;
}

async function api(method, path, body) {
  const res = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${jwt()}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non JSON */ }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json?.errors ?? text).slice(0, 600)}`);
  return json;
}

const [cmd, ...args] = process.argv.slice(2);
const out = (v) => console.log(JSON.stringify(v, null, 2));

async function groups() {
  const r = await api('GET', `/v1/apps/${appId}/betaGroups?fields[betaGroups]=name,isInternalGroup,publicLinkEnabled`);
  return r.data.map((g) => ({ id: g.id, name: g.attributes.name, internal: g.attributes.isInternalGroup }));
}

switch (cmd) {
  case 'groups':
    out(await groups());
    break;
  case 'testers': {
    const g = (await groups()).find((x) => x.name === args[0]);
    if (!g) throw new Error(`gruppo «${args[0]}» non trovato`);
    const r = await api('GET', `/v1/betaGroups/${g.id}/betaTesters?fields[betaTesters]=email,firstName,lastName,state`);
    out(r.data.map((t) => ({ id: t.id, ...t.attributes })));
    break;
  }
  case 'invite': {
    const [email, firstName, lastName, role = 'CUSTOMER_SUPPORT'] = args;
    if (!email || !firstName || !lastName) throw new Error('uso: invite <email> <nome> <cognome> [ruolo]');
    const r = await api('POST', '/v1/userInvitations', {
      data: {
        type: 'userInvitations',
        attributes: { email, firstName, lastName, roles: [role], allAppsVisible: false, provisioningAllowed: false },
        relationships: { visibleApps: { data: [{ type: 'apps', id: appId }] } },
      },
    });
    out({ id: r.data.id, ...r.data.attributes });
    break;
  }
  case 'add-internal': {
    const [email, groupName] = args;
    const g = (await groups()).find((x) => x.name === groupName);
    if (!g) throw new Error(`gruppo «${groupName}» non trovato`);
    // Tester interno = utente del team: cerca l'utente, poi crea il betaTester nel gruppo.
    const users = await api('GET', `/v1/users?filter[username]=${encodeURIComponent(email)}`);
    if (!users.data.length) throw new Error(`${email} non è ancora un utente del team (invito non accettato?)`);
    const r = await api('POST', '/v1/betaTesters', {
      data: {
        type: 'betaTesters',
        attributes: { email, firstName: users.data[0].attributes.firstName, lastName: users.data[0].attributes.lastName },
        relationships: { betaGroups: { data: [{ type: 'betaGroups', id: g.id }] } },
      },
    });
    out({ id: r.data.id, ...r.data.attributes });
    break;
  }
  case 'uninvite': {
    const [email] = args;
    if (!email) throw new Error('uso: uninvite <email>');
    const r = await api('GET', `/v1/userInvitations?filter[email]=${encodeURIComponent(email)}`);
    if (!r.data.length) throw new Error(`nessun invito in attesa per ${email}`);
    for (const inv of r.data) await api('DELETE', `/v1/userInvitations/${inv.id}`);
    out({ removed: r.data.map((i) => i.id) });
    break;
  }
  case 'devices': {
    const r = await api('GET', '/v1/devices?fields[devices]=name,udid,platform,status,deviceClass&limit=100');
    out(r.data.map((d) => ({ id: d.id, ...d.attributes })));
    break;
  }
  case 'device': {
    const [name, udid] = args;
    if (!name || !udid) throw new Error('uso: device <nome> <udid>');
    const r = await api('POST', '/v1/devices', {
      data: { type: 'devices', attributes: { name, udid: udid.trim(), platform: 'IOS' } },
    });
    out({ id: r.data.id, ...r.data.attributes });
    break;
  }
  case 'bundles': {
    const r = await api('GET', '/v1/bundleIds?filter[identifier]=com.websdbm.ernie,com.websdbm.ernie.widgets&include=bundleIdCapabilities&limit=20');
    const caps = new Map((r.included ?? []).map((c) => [c.id, c.attributes.capabilityType]));
    out(r.data.map((b) => ({
      id: b.id,
      identifier: b.attributes.identifier,
      platform: b.attributes.platform,
      capabilities: (b.relationships?.bundleIdCapabilities?.data ?? []).map((c) => caps.get(c.id) ?? c.id),
    })));
    break;
  }
  case 'app-groups': {
    const [identifier, name = identifier] = args;
    if (!identifier) throw new Error('uso: app-groups <identifier> [nome]');
    const found = await api('GET', `/v1/bundleIds?filter[identifier]=${encodeURIComponent(identifier)}&include=bundleIdCapabilities`);
    let bundle = found.data.find((b) => b.attributes.identifier === identifier);
    if (!bundle) {
      const created = await api('POST', '/v1/bundleIds', {
        data: { type: 'bundleIds', attributes: { identifier, name: name.replace(/[^A-Za-z0-9 ]/g, ' '), platform: 'IOS' } },
      });
      bundle = created.data;
      console.error(`App ID ${identifier} registrato (${bundle.id})`);
    }
    const has = (found.included ?? []).some((c) => c.attributes.capabilityType === 'APP_GROUPS' && (bundle.relationships?.bundleIdCapabilities?.data ?? []).some((x) => x.id === c.id));
    if (has) {
      out({ id: bundle.id, identifier, appGroups: 'già abilitata' });
      break;
    }
    const r = await api('POST', '/v1/bundleIdCapabilities', {
      data: {
        type: 'bundleIdCapabilities',
        attributes: { capabilityType: 'APP_GROUPS' },
        relationships: { bundleId: { data: { type: 'bundleIds', id: bundle.id } } },
      },
    });
    out({ id: bundle.id, identifier, capability: r.data.id, appGroups: 'abilitata' });
    break;
  }
  case 'whats-new': {
    // Stesso testo della schermata «Novità» dell'app: cosa è cambiato e come provarlo.
    const build = Number(args[0]);
    const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'Ernie', 'Resources', 'Changelog.json');
    const entry = JSON.parse(readFileSync(file, 'utf8')).find((e) => e.build === build);
    if (!entry) throw new Error(`nessuna voce per la build ${build} in Changelog.json`);
    const text = [
      `Versione ${entry.build} — ${entry.title}`,
      '',
      ...entry.items.flatMap((i) => [`• ${i.title}: ${i.detail}`, ...(i.test ? [`  Come provarla: ${i.test}`] : []), '']),
    ]
      .join('\n')
      // TestFlight rifiuta alcuni simboli («✕», frecce): al loro posto le parole.
      .replace(/✕/g, 'X')
      .replace(/↑/g, 'la freccia in su')
      .replace(/[\u2190-\u21FF\u2700-\u27BF]/g, '')
      .trim()
      .slice(0, 4000);
    // Dopo il caricamento la build compare nell'API con qualche minuto di ritardo: con --wait si aspetta (max 20 min).
    let b = null;
    for (let i = 0; i < (args.includes('--wait') ? 80 : 1); i++) {
      const r = await api('GET', `/v1/builds?filter[app]=${appId}&filter[version]=${build}&limit=1`);
      b = r.data[0] ?? null;
      if (b) break;
      await new Promise((ok) => setTimeout(ok, 15_000));
    }
    if (!b) throw new Error(`build ${build} non ancora visibile su App Store Connect`);
    const locs = await api('GET', `/v1/builds/${b.id}/betaBuildLocalizations`);
    const it = locs.data.find((l) => l.attributes.locale.startsWith('it'));
    if (it)
      await api('PATCH', `/v1/betaBuildLocalizations/${it.id}`, {
        data: { type: 'betaBuildLocalizations', id: it.id, attributes: { whatsNew: text } },
      });
    else
      await api('POST', '/v1/betaBuildLocalizations', {
        data: {
          type: 'betaBuildLocalizations',
          attributes: { locale: 'it', whatsNew: text },
          relationships: { build: { data: { type: 'builds', id: b.id } } },
        },
      });
    out({ build, buildId: b.id, caratteri: text.length, cosaTestare: 'scritto' });
    break;
  }
  case 'get': {
    // Sonda generica (diagnostica): node asc.mjs get /v1/bundleIds
    out(await api('GET', args[0]));
    break;
  }
  default:
    console.error('comandi: groups | testers <gruppo> | invite <email> <nome> <cognome> [ruolo] | uninvite <email> | add-internal <email> <gruppo> | devices | device <nome> <udid> | bundles | app-groups <identifier> [nome] | whats-new <build> [--wait] | get <path>');
    process.exit(64);
}
