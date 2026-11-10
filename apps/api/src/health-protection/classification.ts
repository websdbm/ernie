import { looksLikeLabReport } from '@ernie/brain';

/** Conservative local guard; explicit Health import is authoritative, OCR recognition is best effort. */
export function isPrivateHealthDocument(text: string, title = ''): boolean {
  const content = `${title}\n${text}`.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  return (
    looksLikeLabReport(text) ||
    /\b(?:referto|emocromo|diagnosi|prescrizione medica|esami? (?:del sangue|clinici)|analisi (?:cliniche|del sangue)|cartella clinica|anamnesi|laboratorio analisi)\b/i.test(
      content,
    ) ||
    [
      'glicemia',
      'colesterolo',
      'creatinina',
      'emoglobina',
      'trigliceridi',
      'leucociti',
      'piastrine',
    ].filter((word) => content.includes(word)).length >= 2 ||
    (content.includes('paziente') &&
      ['mg/dl', 'mmol/l', 'valori di riferimento', 'intervallo di riferimento'].some((word) =>
        content.includes(word),
      ))
  );
}
export const PRIVATE_HEALTH_UPLOAD = {
  error: 'health_private_upload',
  message:
    'Questo documento sembra un referto. Importalo dalla sezione Salute per conservarlo cifrato.',
};
