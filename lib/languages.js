'use strict';

/**
 * code   : identifiant utilisé pour nommer les fichiers générés (fr, en-GB, pt-BR…)
 * native : nom de la langue dans sa propre langue (affiché dans l'interface)
 * label  : nom en français (utilisé pour la recherche et la liste de langue source)
 * deepl  : code cible DeepL (null = non supporté par DeepL)
 * google : code Google Traduction
 */
const LANGUAGES = [
  { code: 'ar', native: 'العربية', label: 'Arabe', deepl: 'AR', google: 'ar' },
  { code: 'bg', native: 'Български', label: 'Bulgare', deepl: 'BG', google: 'bg' },
  { code: 'cs', native: 'Čeština', label: 'Tchèque', deepl: 'CS', google: 'cs' },
  { code: 'da', native: 'Dansk', label: 'Danois', deepl: 'DA', google: 'da' },
  { code: 'de', native: 'Deutsch', label: 'Allemand', deepl: 'DE', google: 'de' },
  { code: 'el', native: 'Ελληνικά', label: 'Grec', deepl: 'EL', google: 'el' },
  { code: 'en', native: 'English', label: 'Anglais', deepl: 'EN-US', google: 'en' },
  { code: 'en-GB', native: 'English (UK)', label: 'Anglais britannique', deepl: 'EN-GB', google: 'en' },
  { code: 'es', native: 'Español', label: 'Espagnol', deepl: 'ES', google: 'es' },
  { code: 'et', native: 'Eesti', label: 'Estonien', deepl: 'ET', google: 'et' },
  { code: 'fi', native: 'Suomi', label: 'Finnois', deepl: 'FI', google: 'fi' },
  { code: 'fr', native: 'Français', label: 'Français', deepl: 'FR', google: 'fr' },
  { code: 'he', native: 'עברית', label: 'Hébreu', deepl: null, google: 'he' },
  { code: 'hi', native: 'हिन्दी', label: 'Hindi', deepl: null, google: 'hi' },
  { code: 'hu', native: 'Magyar', label: 'Hongrois', deepl: 'HU', google: 'hu' },
  { code: 'id', native: 'Bahasa Indonesia', label: 'Indonésien', deepl: 'ID', google: 'id' },
  { code: 'it', native: 'Italiano', label: 'Italien', deepl: 'IT', google: 'it' },
  { code: 'ja', native: '日本語', label: 'Japonais', deepl: 'JA', google: 'ja' },
  { code: 'ko', native: '한국어', label: 'Coréen', deepl: 'KO', google: 'ko' },
  { code: 'lt', native: 'Lietuvių', label: 'Lituanien', deepl: 'LT', google: 'lt' },
  { code: 'lv', native: 'Latviešu', label: 'Letton', deepl: 'LV', google: 'lv' },
  { code: 'nb', native: 'Norsk bokmål', label: 'Norvégien', deepl: 'NB', google: 'no' },
  { code: 'nl', native: 'Nederlands', label: 'Néerlandais', deepl: 'NL', google: 'nl' },
  { code: 'pl', native: 'Polski', label: 'Polonais', deepl: 'PL', google: 'pl' },
  { code: 'pt', native: 'Português (PT)', label: 'Portugais du Portugal', deepl: 'PT-PT', google: 'pt' },
  { code: 'pt-BR', native: 'Português (BR)', label: 'Portugais du Brésil', deepl: 'PT-BR', google: 'pt' },
  { code: 'ro', native: 'Română', label: 'Roumain', deepl: 'RO', google: 'ro' },
  { code: 'ru', native: 'Русский', label: 'Russe', deepl: 'RU', google: 'ru' },
  { code: 'sk', native: 'Slovenčina', label: 'Slovaque', deepl: 'SK', google: 'sk' },
  { code: 'sl', native: 'Slovenščina', label: 'Slovène', deepl: 'SL', google: 'sl' },
  { code: 'sv', native: 'Svenska', label: 'Suédois', deepl: 'SV', google: 'sv' },
  { code: 'th', native: 'ไทย', label: 'Thaï', deepl: null, google: 'th' },
  { code: 'tr', native: 'Türkçe', label: 'Turc', deepl: 'TR', google: 'tr' },
  { code: 'uk', native: 'Українська', label: 'Ukrainien', deepl: 'UK', google: 'uk' },
  { code: 'vi', native: 'Tiếng Việt', label: 'Vietnamien', deepl: null, google: 'vi' },
  { code: 'zh', native: '中文（简体）', label: 'Chinois simplifié', deepl: 'ZH', google: 'zh-CN' },
];

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));

/** Langues proposées comme langue source (pas de variantes régionales). */
const SOURCE_LANGUAGES = LANGUAGES.filter((l) => !l.code.includes('-'));

function getLanguage(code) {
  return BY_CODE.get(String(code)) ?? null;
}

module.exports = { LANGUAGES, SOURCE_LANGUAGES, getLanguage };