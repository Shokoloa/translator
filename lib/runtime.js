'use strict';

const path = require('path');

/**
 * Une fois empaqueté avec pkg (voir `npm run build:win`), le code tourne dans un instantané en
 * lecture seule : __dirname y pointe vers un chemin virtuel où on ne peut ni écrire ni lire un
 * .env modifiable. process.pkg n'existe QUE dans ce cas — on s'en sert pour retrouver le vrai
 * dossier où vit l'exécutable (process.execPath), et y lire/écrire tout ce qui doit rester modifiable.
 * En dehors d'un exécutable pkg (npm start classique), on revient simplement à la racine du projet.
 */
function appDir() {
    return process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..');
}

module.exports = { appDir, isPackaged: Boolean(process.pkg) };