import type { DeviceContext } from '@ernie/protocol';

/** Fuso valido per Intl, altrimenti null (un fuso inventato non deve rompere il turno). */
function validZone(tz: string | undefined): string | null {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat('it-IT', { timeZone: tz }).format(0);
    return tz;
  } catch {
    return null;
  }
}

function age(at: string | undefined, now: Date): number | null {
  if (!at) return null;
  const t = Date.parse(at);
  if (Number.isNaN(t)) return null;
  return Math.max(0, now.getTime() - t);
}

function agoText(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 2) return 'adesso';
  if (min < 60) return `${min} minuti fa`;
  const h = Math.round(min / 60);
  return h === 1 ? "un'ora fa" : `${h} ore fa`;
}

/** Oltre questa età la posizione non è più «attuale»: si dice che è l'ultima nota. */
const STALE_MS = 2 * 3_600_000;
/** Oltre questa età la posizione non si passa affatto. */
const DROP_MS = 24 * 3_600_000;

/**
 * Contesto del turno con ora locale e posizione del telefono (protocollo v1.10). Fuori dal prefisso in cache:
 * cambia a ogni turno senza invalidare il prompt. Le coordinate sono arrotondate al centesimo (circa 1 km):
 * per meteo, luoghi vicini e orari basta la città, e al modello non serve di più.
 */
export function formatDeviceContext(
  device: DeviceContext | undefined,
  now = new Date(),
): string | null {
  if (!device) return null;
  const lines: string[] = [];
  const tz = validZone(device.timezone);
  if (tz) {
    const local = new Intl.DateTimeFormat('it-IT', {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone: tz,
    }).format(now);
    lines.push(`Ora locale dell'utente: ${local} (fuso ${tz}).`);
  }
  const loc = device.location;
  const ms = age(loc?.at, now);
  if (loc && (ms === null || ms <= DROP_MS)) {
    const where = loc.place?.replace(/\s+/g, ' ').trim();
    const coords = `${loc.latitude.toFixed(2)}, ${loc.longitude.toFixed(2)}`;
    const precision =
      loc.accuracyM !== undefined
        ? `precisione circa ${loc.accuracyM < 1000 ? `${Math.max(100, Math.round(loc.accuracyM / 100) * 100)} m` : `${Math.round(loc.accuracyM / 1000)} km`}`
        : null;
    const when = ms !== null ? `rilevata ${agoText(ms)}` : null;
    const details = [coords, precision, when].filter(Boolean).join('; ');
    const label = ms !== null && ms > STALE_MS ? 'Ultima posizione nota' : 'Posizione attuale';
    lines.push(`${label} dal telefono: ${where ? `${where} (${details})` : details}.`);
  }
  if (!lines.length) return null;
  return [
    'Contesto dal telefono dell’utente (dato del dispositivo, affidabile):',
    ...lines,
    'Usali quando servono (meteo, luoghi vicini, orari, «qui», «oggi», «stasera») senza chiedere dove si trova o che ore sono e senza chiamare get_time; non citarli se la domanda non c’entra.',
    'Ora e posizione valgono adesso: se nei turni precedenti erano diverse, l’utente si è spostato o è passato del tempo, non hai sbagliato tu; non correggere né scusarti per le risposte passate.',
  ].join('\n');
}
