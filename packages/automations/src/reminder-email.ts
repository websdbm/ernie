import type { ReminderDetails } from '@ernie/protocol';

/**
 * Email HTML del promemoria (richiesta dell'utente, 13 ott 2026): tutti i riferimenti (cosa, quando, la frase
 * detta, chi l'ha messo e quando, la ricorrenza) e l'orso di Ernie. HTML a tabelle con stili in linea, come
 * vogliono i client di posta; accanto c'è sempre la versione in testo semplice.
 */
export interface ReminderEmailInput extends ReminderDetails {
  /** Titolo breve del promemoria («Fatturare alla pizzeria romana 900 euro»). */
  readonly title: string;
  /** Quando suona, già scritto per esteso («lunedì 2 novembre 2026 alle 09:00»). */
  readonly when: string;
  /** Frase detta all'inizio, se diversa dal titolo. */
  readonly spoken?: string;
  /** Chi l'ha messo, se è un familiare («papà»). */
  readonly from?: string;
  /** Quando è stato impostato, per esteso. */
  readonly createdOn?: string;
  /** Ricorrenza leggibile («ogni venerdì alle 9»). */
  readonly repeat?: string;
  /** URL pubblico dell'immagine dell'orso. */
  readonly bearUrl?: string;
}

const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export function reminderEmailSubject(i: ReminderEmailInput): string {
  return `⏰ ${i.from ? `Promemoria da ${i.from}` : 'Promemoria'}: ${i.title}`.slice(0, 200);
}

export function reminderEmailText(i: ReminderEmailInput): string {
  return [
    `${i.from ? `Promemoria da ${i.from}` : 'Promemoria'}: ${i.title}`,
    '',
    `Quando: ${i.when}`,
    ...(i.location ? [`Luogo: ${i.location}`] : []),
    ...(i.url ? [`Link: ${i.url}`] : []),
    ...(i.notes ? [`Note: ${i.notes}`] : []),
    ...(i.repeat ? [`Ripetizione: ${i.repeat}`] : []),
    ...(i.spoken ? [`Detto così: «${i.spoken}»`] : []),
    ...(i.from ? [`Messo da: ${i.from}`] : []),
    ...(i.createdOn ? [`Impostato il: ${i.createdOn}`] : []),
    '',
    "Per spostarlo o annullarlo, chiedilo a Ernie oppure apri l'app › menu › Promemoria.",
  ].join('\n');
}

export function reminderEmailHtml(i: ReminderEmailInput): string {
  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 0;color:#6b6480;font-size:14px;width:120px;vertical-align:top">${esc(label)}</td><td style="padding:6px 0;color:#1d1830;font-size:15px">${value}</td></tr>`;
  const rows = [
    row('Quando', `<strong>${esc(i.when)}</strong>`),
    ...(i.location ? [row('Luogo', esc(i.location))] : []),
    ...(i.url
      ? [
          row(
            'Link',
            /^https?:\/\//iu.test(i.url) ? `<a href="${esc(i.url)}">${esc(i.url)}</a>` : esc(i.url),
          ),
        ]
      : []),
    ...(i.notes ? [row('Note', esc(i.notes).replace(/\n/gu, '<br>'))] : []),
    ...(i.repeat ? [row('Ripetizione', esc(i.repeat))] : []),
    ...(i.spoken ? [row('Detto così', `«${esc(i.spoken)}»`)] : []),
    ...(i.from ? [row('Messo da', esc(i.from))] : []),
    ...(i.createdOn ? [row('Impostato il', esc(i.createdOn))] : []),
  ].join('');
  const bear = i.bearUrl
    ? `<img src="${esc(i.bearUrl)}" width="96" height="96" alt="Ernie" style="display:block;border-radius:48px;border:3px solid #8b5cf6;margin:0 auto 12px">`
    : '';
  return `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(reminderEmailSubject(i))}</title></head>
<body style="margin:0;padding:0;background:#f4f1fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1fb;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:18px;padding:28px 26px;box-shadow:0 4px 18px rgba(80,50,160,0.10)">
<tr><td align="center">${bear}<div style="color:#8b5cf6;font-size:13px;font-weight:600;letter-spacing:.04em;text-transform:uppercase">${esc(i.from ? `Promemoria da ${i.from}` : 'Promemoria')}</div>
<h1 style="margin:8px 0 18px;color:#1d1830;font-size:22px;line-height:1.3">⏰ ${esc(i.title)}</h1></td></tr>
<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #ece8f6;padding-top:10px">${rows}</table></td></tr>
<tr><td style="padding-top:18px;color:#6b6480;font-size:13px;line-height:1.5">Per spostarlo o annullarlo, chiedilo a Ernie oppure apri l'app › menu › Promemoria.</td></tr>
</table>
<div style="color:#a39cb8;font-size:12px;padding-top:14px">Ernie · il tuo assistente personale</div>
</td></tr></table>
</body></html>`;
}
