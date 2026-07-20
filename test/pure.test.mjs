// Dep-free unit tests for Grace's pure functions. Run: npm run test  (after npm run build).
// Imports the built dist directly — keep modules under test free of heavy side-effect deps.
import test from 'node:test';
import assert from 'node:assert/strict';

const { decodeEntities, htmlToText } = await import('../packages/tools/dist/lib/web.js');
const { parseLanguage, languageName } = await import('../packages/core/dist/settings.js');
const { sttCorrections } = await import('../packages/core/dist/sttCorrections.js');
const { routerHint } = await import('../packages/llm/dist/router.js');
const { splitForTTS } = await import('../packages/tts/dist/ttsChunk.js');
const { isHardDenied, classifyReadOnly } = await import('../packages/tools/dist/lib/commandSafety.js');
const { stripHeaderCtl, isSingleRecipient } = await import('../packages/tools/dist/lib/emailHeader.js');
const { nextRecurrence } = await import('../packages/core/dist/scheduler.js');

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

// ── run_command safety (the security boundary) ──
test('commandSafety: chaining/redirection/substitution never auto-run', () => {
  // The critical bypass: a read-only prefix must NOT whitelist a chained destructive command.
  assert.equal(classifyReadOnly('echo x & del foo.txt', false), false);
  assert.equal(classifyReadOnly('git status && node -e "require(1)"', true), false);
  assert.equal(classifyReadOnly('echo x > C:\\Users\\mikke\\.bashrc', false), false); // redirection
  assert.equal(classifyReadOnly('echo `rm -rf ~`', false), false);                    // backtick subst
  assert.equal(classifyReadOnly('echo $(whoami)', false), false);                     // $() subst
});

test('commandSafety: genuine read-only chains still auto-run', () => {
  assert.equal(classifyReadOnly('git status', true), true);
  assert.equal(classifyReadOnly('git log | findstr fix', true), true);   // both segments read-only
  assert.equal(classifyReadOnly('ls', false), true);
  assert.equal(classifyReadOnly('npm run build', false), false);         // build is not read-only
});

test('commandSafety: npm test / tsc only auto-run inside the repo', () => {
  assert.equal(classifyReadOnly('npm test', false), false);  // arbitrary repo → confirm
  assert.equal(classifyReadOnly('npm test', true), true);    // Grace repo → ok
  assert.equal(classifyReadOnly('tsc -b', true), true);
  assert.equal(classifyReadOnly('tsc -b', false), false);
});

test('commandSafety: hard-deny catches destructive forms + aliases', () => {
  for (const c of [
    'rm -rf /', 'rm --recursive --force ~/x', 'rm -rf C:\\Users\\mikke\\Documents',
    'rd /s /q C:\\x', 'erase /q /f a.txt', 'del /q foo', 'Remove-Item -Force -Recurse C:\\x',
    'format C:', 'diskpart', 'shutdown /s', 'reg delete HKLM\\x', 'dd if=/dev/zero of=/dev/sda',
  ]) assert.equal(isHardDenied(c), true, `should hard-deny: ${c}`);
  for (const c of ['git status', 'ls -la', 'npm run build', 'echo hello']) {
    assert.equal(isHardDenied(c), false, `should NOT hard-deny: ${c}`);
  }
});

// ── Gmail header-injection guard ──
test('emailHeader: strips control chars and rejects injected recipients', () => {
  assert.equal(stripHeaderCtl('a@b.com\r\nBcc: evil@x.com'), 'a@b.comBcc: evil@x.com'); // newline gone
  assert.equal(isSingleRecipient('boss@corp.com'), true);
  assert.equal(isSingleRecipient('Mikkel <mikkel@example.com>'), true);
  assert.equal(isSingleRecipient('a@b.com, c@d.com'), false);                 // multiple recipients
  assert.equal(isSingleRecipient(stripHeaderCtl('a@b.com\r\nBcc: evil@x.com')), false); // injection blocked
  assert.equal(isSingleRecipient('not-an-email'), false);
});

// ── Scheduler recurrence (no drift, catch up after sleep) ──
test('nextRecurrence: advances from dueAt, steps strictly past now', () => {
  assert.equal(nextRecurrence(1000, 100, 1050), 1100);  // no drift (not 1150 = now+recur)
  assert.equal(nextRecurrence(1000, 100, 1100), 1200);  // boundary → strictly future
  assert.equal(nextRecurrence(1000, 100, 1350), 1400);  // catch up past a slept-through backlog
});
