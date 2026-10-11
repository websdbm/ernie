#!/usr/bin/env node
/**
 * App Store Connect via API con la chiave ASC (JWT ES256), senza Xcode né browser.
 *   node apps/ios/scripts/asc.mjs groups                      elenca i gruppi TestFlight dell'app
 *   node apps/ios/scripts/asc.mjs invite <email> <nome> <cognome> [ruolo]   invita un membro del team (default CUSTOMER_SUPPORT) con accesso alla sola app Ernie
 *   node apps/ios/scripts/asc.mjs add-internal <email> <gruppo>             aggiunge un utente del team (già accettato) al gruppo interno
 *   node apps/ios/scripts/asc.mjs testers <gruppo>                          elenca i tester di un gruppo
 * Variabili: ASC_KEY_ID (default APWGU2N593), ASC_ISSUER_ID, ASC_KEY_PATH (~/.appstoreconnect/private_keys/AuthKey_<id>.p8), ASC_APP_ID (default 6821598639).
 */
import { readFileSync } from 'node:fs';
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
  default:
    console.error('comandi: groups | testers <gruppo> | invite <email> <nome> <cognome> [ruolo] | add-internal <email> <gruppo>');
    process.exit(64);
}
