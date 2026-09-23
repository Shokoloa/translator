'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { protect, restore, skipReason } = require('../lib/placeholders');

const SAMPLES = [
  'Bienvenue {user} !',
  'Salut {{name}}, tu as %d messages et %1$s notifications',
  'Merci <@123456789> et <@&987654321> dans <#111> <:party:222> :tada:',
  'Il est <t:1700000000:R> — `${count}` fois',
  'Un <b>texte</b> avec & des <chevrons> < 3',
];

for (const text of SAMPLES) {
  test(`aller-retour sans perte : ${text}`, () => {
    for (const format of ['xml', 'plain']) {
      const { text: protectedText, tokens } = protect(text, format);
      assert.ok(tokens.length > 0 || !/[{%<:]/.test(text) || format);
      const back = restore(protectedText, tokens, format);
      assert.equal(back.text, text);
      assert.ok(back.ok);
    }
  });
}

test('les variables sont remplacées par des jetons et le reste est échappé', () => {
  const { text, tokens } = protect('Salut {user} & bienvenue', 'xml');
  assert.equal(text, 'Salut <x>0</x> &amp; bienvenue');
  assert.deepEqual(tokens, ['{user}']);
});

test('restore tolère les espaces ajoutés par le service et décode les entités HTML', () => {
  const { tokens } = protect('Hola {user}', 'xml');
  const back = restore('¡Hola <x> 0 </x>! l&#39;ami &amp; co', tokens, 'xml');
  assert.equal(back.text, "¡Hola {user}! l'ami & co");
  assert.ok(back.ok);
});

test('restore signale une variable perdue', () => {
  const { tokens } = protect('Hola {user}, {count}', 'xml');
  assert.equal(restore('Hola <x>0</x>', tokens, 'xml').ok, false);
});

test('les pourcentages ordinaires ne sont pas pris pour des variables printf', () => {
  assert.deepEqual(protect('100% sûr, 50%off').tokens, []);
  assert.deepEqual(protect('Score : %d points').tokens, ['%d']);
});

test('skipReason', () => {
  assert.equal(skipReason('   '), 'empty');
  assert.equal(skipReason('https://example.com/a'), 'technical');
  assert.equal(skipReason('#ff00aa'), 'technical');
  assert.equal(skipReason('GUILD_TEXT'), 'technical');
  assert.equal(skipReason('{count}'), 'no-text');
  assert.equal(skipReason('123'), 'no-text');
  assert.equal(skipReason('{n, plural, one {# élément} other {# éléments}}'), 'icu');
  assert.equal(skipReason('Bonjour {user}'), null);
  assert.equal(skipReason('Bienvenue'), null);
});