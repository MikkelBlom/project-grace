// Dep-free unit tests for Grace's pure functions. Run: npm run test  (after npm run build).
// Imports the built dist directly — keep modules under test free of heavy side-effect deps.
import test from 'node:test';
import assert from 'node:assert/strict';

const { decodeEntities, htmlToText } = await import('../packages/tools/dist/lib/web.js');
const { parseLanguage, languageName } = await import('../packages/core/dist/settings.js');
const { sttCorrections } = await import('../packages/core/dist/sttCorrections.js');
const { routerHint } = await import('../packages/llm/dist/router.js');
const { splitForTTS } = await import('../packages/tts/dist/ttsChunk.js');

test('decodeEntities: danish + numeric + named', () => {
  assert.equal(decodeEntities('caf&eacute; &aelig;&oslash;&aring;'), 'café æøå');
  assert.equal(decodeEntities('a &amp; b &#8211; c &#x2019;'), 'a & b – c ’');
  assert.equal(decodeEntities('no entities here'), 'no entities here');
});

test('htmlToText: strips boilerplate + decodes', () => {
  const out = htmlToText('<html><body><nav>MENU</nav><h1>T</h1><p>Hej &amp; verden &oslash;l</p><footer>F</footer></body></html>');
  assert.ok(out.includes('Hej & verden øl'));
  assert.ok(!out.includes('MENU'));
  assert.ok(!out.includes('F</'));
  assert.equal(htmlToText('', 100), '');
});

test('htmlToText: respects maxChars', () => {
  assert.equal(htmlToText('<p>abcdefghij</p>', 4).length, 4);
});

test('parseLanguage: da/en variants', () => {
  assert.equal(parseLanguage('dansk'), 'da');
  assert.equal(parseLanguage('DK'), 'da');
  assert.equal(parseLanguage('English'), 'en');
  assert.equal(parseLanguage('in english please'), 'en');
  assert.equal(parseLanguage('xyz'), null);
  assert.equal(languageName('da'), 'Danish');
});

test('sttCorrections: whole-word, case-insensitive, reversible', () => {
  assert.equal(sttCorrections.apply('hej grys'), 'hej Grace');           // seeded
  assert.equal(sttCorrections.apply('grysende'), 'grysende');            // not whole-word
  const r = sttCorrections.add('klovd', 'Claude');
  assert.equal(r.ok, true);
  assert.equal(sttCorrections.apply('spørg KLOVD'), 'spørg Claude');
  assert.equal(sttCorrections.remove('klovd'), true);                    // cleanup
  assert.equal(sttCorrections.apply('spørg klovd'), 'spørg klovd');
});

test('routerHint: action vs knowledge vs none', () => {
  assert.match(routerHint('open my project folder'), /fast path/);
  assert.match(routerHint('what is the capital of france'), /research/);
  assert.equal(routerHint('hej'), null);
});

test('splitForTTS: chunks multi-sentence, keeps single short', () => {
  const chunks = splitForTTS('Hej Mikkel. Det er en god idé. Jeg finder filen nu, og så åbner jeg den.');
  assert.ok(chunks.length >= 2);
  assert.equal(splitForTTS('Kort.').length, 1);
  assert.ok(chunks.join(' ').includes('Hej Mikkel'));
});
