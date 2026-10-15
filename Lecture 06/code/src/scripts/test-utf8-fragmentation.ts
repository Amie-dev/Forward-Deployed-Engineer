/**
 * UTF-8 FRAGMENTATION TORTURE TEST (§4.4 / §4.5 / §10.5 level 1).
 *
 * Streaming correctness is temporal: the same bytes produce different output
 * depending on how they are sliced. This script proves two things:
 *
 *   1. Incremental decoding — ONE `TextDecoder` with `{ stream: true }` plus a
 *      final flush — is byte-boundary agnostic, down to one byte per read.
 *   2. The naive alternative (a fresh decoder per chunk, which is what most
 *      broken clients do) really does corrupt multi-byte characters. The bug is
 *      demonstrated, not just described.
 *
 * Run: npm run test:utf8
 */

const SAMPLES: Array<{ name: string; text: string }> = [
  { name: 'emoji (4-byte)', text: 'Rocket 🚀 launched 🌍 with 🧑‍🚀 crew' },
  { name: 'CJK (3-byte)', text: '日本語のテキストと中文文本の混合' },
  { name: 'combining marks', text: 'e\u0301 vs é — and ǹ, ǹ, ǹ' },
  { name: 'RTL + ZWJ', text: 'مرحبا بالعالم — 👨‍👩‍👧‍👦' },
  { name: 'streamed markdown', text: '**bold** `code` ∑ ∆ ≈ λ\n```js\nconst x = 1;\n```\n' },
  { name: 'mixed answer', text: 'Spring Boot is a framework. 日本語! 🚀 ∑ ∆' },
];

const FRAGMENT_SIZES = [1, 2, 3, 5, 17, 64, 1_024];

async function main(): Promise<void> {
  const { fragmentStringByBytes, utf8ByteLength } = await import('../lib/text-codec.js');
  const { assert, exitWithSummary, paint, section, table } = await import('./harness.js');

  section('1. Byte accounting: characters are NOT bytes');
  const emoji = '🚀';
  assert(emoji.length === 2, `'🚀' is ${emoji.length} UTF-16 code units in JavaScript`);
  assert(utf8ByteLength(emoji) === 4, `'🚀' is ${utf8ByteLength(emoji)} bytes on the wire`);
  const cjk = '日';
  assert(utf8ByteLength(cjk) === 3, `'日' is ${utf8ByteLength(cjk)} bytes on the wire`);

  section('2. Incremental decoding survives hostile fragmentation');
  const rows: Array<Record<string, string | number>> = [];
  let boundaryFailures = 0;

  for (const sample of SAMPLES) {
    for (const size of FRAGMENT_SIZES) {
      const fragments = fragmentStringByBytes(sample.text, size);

      // ✅ The correct discipline: ONE decoder, `{ stream: true }`, flush at the end.
      const decoder = new TextDecoder('utf-8');
      let incremental = '';
      for (const fragment of fragments) incremental += decoder.decode(fragment, { stream: true });
      incremental += decoder.decode();

      if (incremental !== sample.text) {
        boundaryFailures += 1;
        rows.push({ sample: sample.name, bytes: size, result: '❌ CORRUPTED' });
      }
    }
  }

  assert(
    boundaryFailures === 0,
    'Every fragment size reassembles the original string exactly',
    `${SAMPLES.length * FRAGMENT_SIZES.length} combinations checked (1 byte at a time included)`
  );

  section('3. The naive client really does break (negative control)');
  const corruptions: Array<Record<string, string | number>> = [];

  for (const sample of SAMPLES) {
    for (const size of [1, 2, 3]) {
      const fragments = fragmentStringByBytes(sample.text, size);
      // ❌ A new TextDecoder per chunk — the classic bug.
      const naive = fragments.map((fragment) => new TextDecoder('utf-8').decode(fragment)).join('');
      if (naive !== sample.text) {
        corruptions.push({
          sample: sample.name,
          bytesPerRead: size,
          replacementChars: (naive.match(/\uFFFD/g) ?? []).length,
          matchesOriginal: 'no',
        });
      }
    }
  }

  table(corruptions);
  assert(
    corruptions.length > 0,
    'A per-chunk TextDecoder produces U+FFFD replacement characters',
    `${corruptions.length} corrupted combinations — this is the bug the discipline prevents`
  );

  section('4. The final decode() flush matters when a stream ends mid-character');
  const tailSample = 'end 🚀';
  const tailBytes = Buffer.from(tailSample, 'utf8');
  // Simulate a stream that dies two bytes into the final 4-byte emoji.
  const truncated = tailBytes.subarray(0, tailBytes.length - 2);

  const flushDecoder = new TextDecoder('utf-8');
  const withoutFlush = flushDecoder.decode(truncated, { stream: true });
  const withFlush = withoutFlush + flushDecoder.decode();

  assert(
    withoutFlush.length < tailSample.length,
    'Without the flush the incomplete character is held back — the text looks shorter',
    `"${withoutFlush}" (${withoutFlush.length} chars)`
  );
  assert(
    withFlush.length > withoutFlush.length && withFlush.includes('\uFFFD'),
    'The flush surfaces the truncation as U+FFFD instead of swallowing it silently',
    `"${withFlush}"`
  );
  assert(
    withoutFlush === 'end ',
    'Everything before the truncated character was still delivered correctly',
    `"${withoutFlush}"`
  );

  console.log(
    `\n${paint.dim(
      'Takeaway: byte boundaries are meaningless to the client. Decode incrementally, buffer frames, and append whatever arrives.'
    )}`
  );

  exitWithSummary('test-utf8-fragmentation');
}

main().catch((error) => {
  console.error('Fatal test error:', error);
  process.exit(1);
});
