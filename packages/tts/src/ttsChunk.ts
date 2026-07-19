/** Split text into speak-sized chunks on sentence boundaries. Flushes each time the buffer reaches
 *  ~24 chars, so the first sentence(s) play quickly (fast first audio) while only merging genuinely
 *  tiny fragments to avoid a flurry of one-word clips. */
export function splitForTTS(text: string): string[] {
  const pieces = text.match(/[^.!?…]+[.!?…]+|\S[^.!?…]*$/g) ?? [text];
  const chunks: string[] = [];
  let buf = '';
  for (const p of pieces) {
    buf = buf ? `${buf} ${p.trim()}` : p.trim();
    if (buf.length >= 24) { chunks.push(buf); buf = ''; }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks.length ? chunks : [text];
}
