'use strict';

const fs = require('fs');
const path = require('path');
const { appDir } = require('./runtime');

const LOG_PATH = process.env.TRANSLATION_LOG_PATH || path.join(appDir(), 'translation-errors.log');

/**
 * Note un échec de traduction (clé manquante, timeout, variable perdue…) sans jamais faire
 * planter l'appelant : si l'écriture du journal elle-même échoue, on l'ignore silencieusement —
 * le journal est un filet de sécurité, pas une étape critique de la traduction.
 */
function log({ project, lang, path: keyPath, text, reason }) {
    const time = new Date().toISOString();
    const where = project ? `projet=${project}` : '';
    const what = keyPath ? `clé="${keyPath}"` : text ? `texte="${String(text).slice(0, 80)}"` : '';
    const line = `[${time}] ${where} lang=${lang ?? '-'} ${what} -> ${reason}\n`;
    try {
        fs.appendFileSync(LOG_PATH, line, 'utf8');
    } catch { /* le journal est secondaire : il ne doit jamais bloquer une traduction */ }
}

module.exports = { log, LOG_PATH };