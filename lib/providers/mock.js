'use strict';

/** Activé avec TRANSLATE_MOCK=1 : préfixe chaque texte par [code-langue]. Sert à tester sans clé API. */
module.exports = {
  name: 'mock',
  label: 'Simulation',
  format: 'xml',
  isConfigured: () => true,
  supports: () => true,
  async translate(texts, { target }) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return texts.map((text) => `[${target.code}] ${text}`);
  },
};