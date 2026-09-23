'use strict';

/**
 * Erreur levée par un service de traduction.
 * code : 'quota' | 'auth' | 'config' | 'rate' | 'network' | 'other'
 *  - quota  : quota épuisé, le service est mis en pause 1 h
 *  - auth   : clé refusée, le service est mis en pause 24 h
 *  - config : service mal installé/configuré, pause 24 h
 *  - rate   : trop de requêtes, on réessaie avec un délai
 *  - network: erreur réseau / 5xx, on réessaie puis on bascule
 */
class ProviderError extends Error {
  constructor(message, { code = 'other', provider = null, retryAfter = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.provider = provider;
    this.retryAfter = retryAfter;
  }
}

/** Le fichier envoyé est illisible ou ne contient rien d'exploitable. */
class ParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ParseError';
  }
}

/** Erreur de saisie, affichée telle quelle à l'utilisateur. */
class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'UserError';
    this.status = status;
  }
}

module.exports = { ProviderError, ParseError, UserError };