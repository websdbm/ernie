import { z } from 'zod';

export const HabitTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u);
export const HabitLabel = z.string().trim().min(1).max(100);
export type HabitTeaching = {
  label: string;
  usualTime?: string;
  exception?: { time: string; offset: number };
};

const habitual = /\b(?:di solito|solitamente|abitualmente|di norma|normalmente)\b/u;
const dated = /\b(?:oggi|domani|ieri)\b/u;
const marker = /\b(?:di solito|solitamente|abitualmente|di norma|normalmente|oggi|domani|ieri)\b/gu;
const clock =
  /(?<![\d:])(?:[01]?\d|2[0-3])[:.][0-5]\d(?![\d:])|\b(?:alle|all')\s*(?:[01]?\d|2[0-3])\b(?!\s*[:.])/gu;
const reminder = /\b(?:ricordami|promemoria|avvisami|notificami|svegliami)\b/u;
const teaching = /\b(?:abitudin[ei]|routine)\b/u;
const teachVerb = /\b(?:impara|annota|registra|salva|memorizza|tieni a mente|ricorda che)\b/u;
const explaining =
  /\b(?:te lo dico|te lo sto dicendo|per farti sapere|per farti conoscere|per farti capire)\b/u;
const normalize = (text: string) =>
  text.toLocaleLowerCase('it').replace(/[’‘]/gu, "'").replace(/\s+/gu, ' ').trim();
const withoutReminderOptOut = (text: string) =>
  text.replace(
    /\b(?:senza|non)\s+(?:(?:creare|impostare|fare)\s+)?(?:un\s+|alcun\s+)?promemori[ao]\b/gu,
    '',
  );

export function habitChatIntent(text: string, pending: boolean) {
  const t = withoutReminderOptOut(normalize(text));
  if (pending && /^(?:s[iì]|s[iì],? (?:salva|va bene)|salva in abitudini)[.!]?$/u.test(t))
    return 'confirm';
  if (pending && /^(?:no|non salvare)[.!]?$/u.test(t)) return 'decline';
  if (reminder.test(t)) return null;
  if (/\bnon\s+(?:salvare|registrare|memorizzare|annotare)\b/u.test(t) && teaching.test(t))
    return 'decline';
  if (
    /^(?:quali sono|che cosa (?:sai|hai imparato)|cosa (?:sai|hai imparato)|mostrami|elenca)\b/u.test(
      t,
    ) &&
    teaching.test(t)
  )
    return 'read';
  if (habitScheduleQuestion(t)) return 'readSchedule';
  if (!t.endsWith('?') && teaching.test(t) && (teachVerb.test(t) || explaining.test(t)))
    return 'teach';
  if (habitual.test(t) && teachVerb.test(t) && !t.endsWith('?')) return 'teach';
  if (
    !t.endsWith('?') &&
    habitual.test(t) &&
    dated.test(t) &&
    Array.from(t.matchAll(clock)).length >= 2
  )
    return 'offer';
  return null;
}

export function referencesHabitDraft(text: string) {
  const t = normalize(text);
  return (
    /\b(?:te lo|quest[oa]|quell[oa]|appena dett[oa])\b/u.test(t) &&
    !Array.from(t.matchAll(clock)).length
  );
}

export function habitLabelKey(label: string) {
  return normalize(label)
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const workExit = (p: string) => /\b(?:esco|esce|uscita|finisco|finisce|stacco)\b/u.test(p);
const work = (p: string) => /\blavoro\b/u.test(p);
export function habitScheduleQuestion(text: string) {
  const t = normalize(text);
  if (reminder.test(t)) return null;
  const match = /^(?:a che ora|quando)\s+(.{1,100})$/u.exec(t);
  if (!match?.[1] || (!habitual.test(t) && !/\boggi\b/u.test(t))) return null;
  const label = match[1]
    .replace(habitual, '')
    .replace(/\boggi\b/u, '')
    .trim();
  const key = habitLabelKey(workExit(label) && work(label) ? 'Uscita dal lavoro' : label);
  return key ? { key, usual: habitual.test(t) } : null;
}

function activityLabel(prefix: string) {
  return prefix
    .replace(/^\s*[,;:.–-]+\s*/u, '')
    .replace(/\s+(?:verso|intorno|fino|entro|alle|all')\s*(?:alle|all')?\s*$/u, '')
    .trim();
}

/** Only extract unambiguous clock times from the corresponding temporal clause. */
export function parseHabitTeaching(text: string): HabitTeaching | null {
  const t = withoutReminderOptOut(normalize(text));
  if (reminder.test(t)) return null;
  const markers = Array.from(t.matchAll(marker));
  const parts = markers.flatMap((m, i) => {
    const clause = t.slice(m.index + m[0].length, markers[i + 1]?.index);
    return Array.from(clause.matchAll(clock), (time) => ({
      when: m[0],
      prefix: activityLabel(clause.slice(0, time.index)),
      time: (time[0].match(/\d+/gu) ?? []).map((d) => d.padStart(2, '0')).join(':'),
    }));
  });
  const usual = parts.filter((p) => habitual.test(p.when));
  const exceptions = parts.filter((p) => dated.test(p.when));
  if (
    !parts.length ||
    usual.length > 1 ||
    exceptions.length > 1 ||
    parts.some((p) => /\b(?:non|forse)\b/u.test(p.prefix)) ||
    parts.length !== Array.from(t.matchAll(clock)).length
  )
    return null;
  const regular = usual[0];
  const special = exceptions[0];
  const leadingActivity = (markers[0]?.index ? t.slice(0, markers[0].index) : '')
    .replace(
      /^(?:(?:impara|annota|registra|salva|memorizza|ricorda|tieni a mente)(?:\s+(?:come abitudine|nelle mie abitudini))?\s+che\s*)/u,
      '',
    )
    .trim();
  const subject = regular?.prefix || special?.prefix || leadingActivity;
  const sameWorkExit =
    regular &&
    special &&
    workExit(regular.prefix) &&
    ((work(special.prefix) &&
      (workExit(special.prefix) || /\b(?:sono|sto|resto|rimango)\b/u.test(special.prefix))) ||
      (work(regular.prefix) && /^(?:esco|stacco|finisco)$/u.test(special.prefix)));
  if (
    regular?.prefix &&
    special?.prefix &&
    !sameWorkExit &&
    habitLabelKey(regular.prefix) !== habitLabelKey(special.prefix)
  )
    return null;
  const label =
    sameWorkExit || (workExit(subject) && work(subject)) ? 'Uscita dal lavoro' : subject;
  if (!HabitLabel.safeParse(label).success || !habitLabelKey(label)) return null;
  const at = (s: string) => (s.includes(':') ? s : `${s}:00`);
  return {
    label,
    ...(regular ? { usualTime: at(regular.time) } : {}),
    ...(special
      ? {
          exception: {
            time: at(special.time),
            offset: special.when === 'domani' ? 1 : special.when === 'ieri' ? -1 : 0,
          },
        }
      : {}),
  };
}

export function habitTimezone(candidate?: string) {
  if (candidate) {
    try {
      return new Intl.DateTimeFormat('it-IT', { timeZone: candidate }).resolvedOptions().timeZone;
    } catch {
      /* invalid device timezone */
    }
  }
  return 'Europe/Rome';
}

export function habitLocalDate(instant: Date, timezone: string, offset = 0) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return new Date(Date.UTC(part('year'), part('month') - 1, part('day') + offset))
    .toISOString()
    .slice(0, 10);
}

export const HABIT_OFFER = 'Vuoi salvare questo orario in Abitudini?';
export const HABIT_SAVE = 'Salva in Abitudini';
