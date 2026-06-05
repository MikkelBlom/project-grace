// analyze_screen — Grace looks at a screenshot with her own eyes.
//
// gemma4 has a native vision encoder, so this just sends the PNG (base64) to the
// SAME Ollama model Grace already uses — no extra model, no VRAM overhead. It can
// describe the screen and, with find_element:true, return a bounding box for a UI
// element. Box coordinates are absolute virtual-desktop pixels (mapped via the
// screenshot's sidecar bounds), ready to hand straight to focus_box.

import { registerTool } from '../registry.js';
import fs from 'fs';

const OLLAMA_URL = process.env.GRACE_OLLAMA_URL ?? 'http://localhost:11434';
const MODEL      = process.env.GRACE_LLM_MODEL  ?? 'gemma4:26b';

/** Read width/height from a PNG's IHDR header (no image deps). */
function pngSize(buf: Buffer): { width: number; height: number } | null {
  // 8-byte signature, then IHDR with width@16, height@20 (big-endian uint32).
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

interface Sidecar { bounds: { x: number; y: number; width: number; height: number }; monitorIndex?: number; }

function readSidecar(imagePath: string): Sidecar | null {
  try { return JSON.parse(fs.readFileSync(`${imagePath}.json`, 'utf-8')) as Sidecar; }
  catch { return null; }
}

/** Pull the first JSON object out of a model reply. */
function extractJson(text: string): any | null {
  const t = (text ?? '').trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) { try { return JSON.parse(fence[1].trim()); } catch { /* */ } }
  const start = t.indexOf('{'), end = t.lastIndexOf('}');
  if (start !== -1 && end > start) { try { return JSON.parse(t.slice(start, end + 1)); } catch { /* */ } }
  return null;
}

/** Accept x_pct or x; treat 0-1 as fraction, 0-100 as percent; clamp to [0,100]. */
function asPercent(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const pct = n > 0 && n <= 1 ? n * 100 : n;
  return Math.max(0, Math.min(100, pct));
}

registerTool({
  name: 'analyze_screen',
  description:
    'Analyze a screenshot using Grace\'s own vision (gemma4 native). ' +
    'Describes what is on screen, finds UI elements, and (with find_element) returns a ' +
    'bounding box in absolute screen pixels. Combine with take_screenshot and focus_box: ' +
    'take_screenshot → analyze_screen(find_element:true) → focus_box(the boundingBox).',
  params: {
    image_path:   { type: 'string',  description: 'Path to the screenshot PNG (from take_screenshot)', required: true },
    question:     { type: 'string',  description: 'What to look for or describe', required: true },
    find_element: { type: 'boolean', description: 'If true, return a bounding box {x,y,w,h} in screen pixels for the described element' },
  },
  async run(args) {
    const imagePath = String(args.image_path ?? '');
    const question = String(args.question ?? '').trim();
    if (!imagePath) return { error: 'analyze_screen needs image_path.' };
    if (!question)  return { error: 'analyze_screen needs a question.' };

    let buf: Buffer;
    try { buf = fs.readFileSync(imagePath); }
    catch (e) { return { error: `Could not read image: ${String(e)}` }; }

    const size = pngSize(buf);
    const sidecar = readSidecar(imagePath);
    const findElement = !!args.find_element;

    // Image dims (DIP) — prefer the sidecar bounds, fall back to the PNG header.
    const imgW = sidecar?.bounds.width ?? size?.width ?? 0;
    const imgH = sidecar?.bounds.height ?? size?.height ?? 0;
    const originX = sidecar?.bounds.x ?? 0;
    const originY = sidecar?.bounds.y ?? 0;

    let prompt = question;
    if (findElement) {
      prompt +=
        '\n\nLocate that element in the image and respond ONLY with a compact JSON object. ' +
        'Use PERCENTAGES of the image size (0-100), with the ORIGIN AT THE TOP-LEFT corner:\n' +
        '  x_pct = how far the element\'s LEFT edge is from the left of the image\n' +
        '  y_pct = how far the element\'s TOP edge is from the top of the image\n' +
        '  w_pct = the element\'s width;  h_pct = the element\'s height\n' +
        'The box must stay inside the image, so x_pct + w_pct <= 100 and y_pct + h_pct <= 100. ' +
        'Example: an element in the top-right quarter ≈ {"x_pct":55,"y_pct":5,"w_pct":40,"h_pct":40}.\n' +
        'Shape: {"found":true,"x_pct":<num>,"y_pct":<num>,"w_pct":<num>,"h_pct":<num>,"note":"<where it is, briefly>"}\n' +
        'If you cannot find it, return {"found":false,"note":"..."}. No other text.';
    }

    let res: Response;
    try {
      res = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: 'user', content: prompt, images: [buf.toString('base64')] }],
          stream: false,
          think: false,
          ...(findElement ? { format: 'json' } : {}),
          options: { temperature: 0.2 },
        }),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (e) {
      return { error: `Could not reach Ollama at ${OLLAMA_URL}: ${String(e)}` };
    }

    if (!res.ok) return { error: `Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };

    const data = await res.json() as { message?: { content?: string } };
    const content = (data.message?.content ?? '').trim();

    if (!findElement) {
      return { description: content || '(no description returned)' };
    }

    // ── find_element: parse percentages, map to absolute screen pixels ──
    const obj = extractJson(content);
    if (!obj || obj.found === false) {
      return { description: obj?.note ?? content, found: false, boundingBox: null };
    }

    const xp = asPercent(obj.x_pct ?? obj.x);
    const yp = asPercent(obj.y_pct ?? obj.y);
    const wp = asPercent(obj.w_pct ?? obj.w);
    const hp = asPercent(obj.h_pct ?? obj.h);
    if (xp == null || yp == null || wp == null || hp == null || imgW === 0 || imgH === 0) {
      return { description: obj.note ?? content, found: false, boundingBox: null,
               note: 'Model did not return usable coordinates.' };
    }

    // Map to absolute pixels, then clamp so the box stays within this monitor —
    // a rough estimate from the model still produces an on-screen box.
    const localX = Math.min((xp / 100) * imgW, imgW - 1);
    const localY = Math.min((yp / 100) * imgH, imgH - 1);
    const w = Math.max(1, Math.min((wp / 100) * imgW, imgW - localX));
    const h = Math.max(1, Math.min((hp / 100) * imgH, imgH - localY));
    const boundingBox = {
      x: Math.round(originX + localX),
      y: Math.round(originY + localY),
      w: Math.round(w),
      h: Math.round(h),
    };

    return {
      description: obj.note ?? content,
      found: true,
      boundingBox,
      percentages: { x_pct: xp, y_pct: yp, w_pct: wp, h_pct: hp },
      monitorIndex: sidecar?.monitorIndex,
    };
  },
});
