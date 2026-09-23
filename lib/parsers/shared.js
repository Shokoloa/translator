'use strict';

/**
 * Renvoie une fonction (key, pathString) => boolean.
 * Une entrée peut être un nom de clé ("icon") ou un chemin complet ("meta.version").
 * Ignorer une clé ignore aussi tout ce qu'elle contient.
 */
function makeIgnore(ignoreKeys = []) {
  const set = new Set(ignoreKeys.map((k) => String(k).trim().toLowerCase()).filter(Boolean));
  if (set.size === 0) return () => false;
  return (key, pathString) => set.has(String(key).toLowerCase()) || set.has(pathString.toLowerCase());
}

module.exports = { makeIgnore };