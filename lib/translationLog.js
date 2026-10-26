'use strict';

const fs = require('fs');
const path = require('path');
const { appDir } = require('./runtime');

const LOG_PATH = process.env.TRANSLATION_LOG_PATH || path.join(appDir(), 'translation-errors.log');
const MAX_LOG_BYTES = 5 * 1024 * 1024; // au-delà, l'ancien journal passe en .old (un seul fichier d'archive)

const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

/**
 * Note un échec de traduction (clé manquante, timeout, variable perdue…) sans jamais faire
 * planter l'appelant : si l'écriture du journal elle-même échoue, on l'ignore silencieusement —
 * le journal est un filet de sécurité, pas une étape critique de la traduction.
 */
function log({ project, lang, path: keyPath, text, reason }) {
    const time = new Date().toISOString();
    const where = project ? `projet=${project}` : '';
    const what = keyPath ? `clé="${oneLine(keyPath)}"` : text ? `texte="${oneLine(text).slice(0, 80)}"` : '';
    const line = `[${time}] ${where} lang=${lang ?? '-'} ${what} -> ${oneLine(reason)}\n`;
    try {
        try {
            if (fs.statSync(LOG_PATH).size > MAX_LOG_BYTES) fs.renameSync(LOG_PATH, `${LOG_PATH}.old`);
        } catch { /* pas encore de journal : rien à archiver */ }
        fs.appendFileSync(LOG_PATH, line, 'utf8');
    } catch { /* le journal est secondaire : il ne doit jamais bloquer une traduction */ }
}

module.exports = { log, LOG_PATH };