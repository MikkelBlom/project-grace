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
      // gemma4 shares Gemini's lineage and is trained to emit bounding boxes as
      // box_2d = [ymin, xmin, ymax, xmax] normalized to 0-1000 (origin top-left).
      // Asking in that native format is far more reliable than a custom x/y/w/h
      // percentage scheme (which the model tends to collapse to 100s).
      prompt +=
        '\n\nFind that element and respond ONLY with a compact JSON object. Give its bounding ' +
        'box as "box_2d": [ymin, xmin, ymax, xmax], with every value normalized to 0-1000 ' +
        '(0 = top/left edge of the image, 1000 = bottom/right edge; origin at the top-left corner).\n' +
        'Shape: {"found":true,"box_2d":[<ymin>,<xmin>,<ymax>,<xmax>],"note":"<where it is, briefly>"}\n' +
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

    // ── find_element: parse the box, map to absolute screen pixels ──
    const obj = extractJson(content);
    if (!obj || obj.found === false) {
      return { description: obj?.note ?? content, found: false, boundingBox: null };
    }
    if (imgW === 0 || imgH === 0) {
      return { description: obj.note ?? content, found: false, boundingBox: null,
               note: 'Unknown image dimensions — cannot map coordinates.' };
    }

    let localX: number, localY: number, w: number, h: number;
    let raw: Record<string, unknown>;

    // Preferred: gemma4/Gemini-native box_2d = [ymin, xmin, ymax, xmax] in 0-1000.
    const box = Array.isArray(obj.box_2d) ? obj.box_2d
              : Array.isArray(obj.bbox)   ? obj.bbox
              : Array.isArray(obj.box)    ? obj.box : null;
    if (box && box.length === 4 && box.every((n: unknown) => Number.isFinite(Number(n)))) {
      const clamp1000 = (v: number) => Math.max(0, Math.min(1000, v));
      let [ymin, xmin, ymax, xmax] = (box as number[]).map(Number);
      if (ymax < ymin) [ymin, ymax] = [ymax, ymin]; // tolerate reversed order
      if (xmax < xmin) [xmin, xmax] = [xmax, xmin];
      ymin = clamp1000(ymin); xmin = clamp1000(xmin); ymax = clamp1000(ymax); xmax = clamp1000(xmax);
      localX = (xmin / 1000) * imgW;
      localY = (ymin / 1000) * imgH;
      w = ((xmax - xmin) / 1000) * imgW;
      h = ((ymax - ymin) / 1000) * imgH;
      raw = { box_2d: [ymin, xmin, ymax, xmax] };
    } else {
      // Fallback: older x_pct/y_pct/w_pct/h_pct percentage form.
      const xp = asPercent(obj.x_pct ?? obj.x), yp = asPercent(obj.y_pct ?? obj.y);
      const wp = asPercent(obj.w_pct ?? obj.w), hp = asPercent(obj.h_pct ?? obj.h);
      if (xp == null || yp == null || wp == null || hp == null) {
        return { description: obj.note ?? content, found: false, boundingBox: null,
                 note: 'Model did not return usable coordinates.' };
      }
      localX = (xp / 100) * imgW; localY = (yp / 100) * imgH;
      w = (wp / 100) * imgW; h = (hp / 100) * imgH;
      raw = { x_pct: xp, y_pct: yp, w_pct: wp, h_pct: hp };
    }

    // Clamp so the box stays within this monitor — a rough estimate still renders.
    localX = Math.min(Math.max(0, localX), imgW - 1);
    localY = Math.min(Math.max(0, localY), imgH - 1);
    w = Math.max(1, Math.min(w, imgW - localX));
    h = Math.max(1, Math.min(h, imgH - localY));

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
      raw,
      monitorIndex: sidecar?.monitorIndex,
    };
  },
});
