'use strict';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Fusionne `patch` dans `target` (en place) : les objets se combinent récursivement, tout le reste est écrasé. */
function deepMerge(target, patch) {
    for (const [key, value] of Object.entries(patch)) {
        if (isPlainObject(value) && isPlainObject(target[key])) deepMerge(target[key], value);
        else target[key] = value;
    }
    return target;
}

/** Aplatit un objet imbriqué en paires [chemin.pointé, valeur] pour les feuilles de type chaîne. */
function flattenStrings(obj, prefix = [], out = []) {
    for (const [key, value] of Object.entries(obj)) {
        const path = [...prefix, key];
        if (typeof value === 'string') out.push([path.join('.'), value]);
        else if (isPlainObject(value)) flattenStrings(value, path, out);
        // nombres, booléens, tableaux, null : fusionnés tels quels, jamais traduits
    }
    return out;
}

module.exports = { deepMerge, isPlainObject, flattenStrings };