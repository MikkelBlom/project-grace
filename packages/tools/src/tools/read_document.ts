import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { registerTool } from '../registry.js';
import { htmlToText } from '../lib/web.js';

const PY = process.env.GRACE_PYTHON_CMD ?? 'py';
const PY_VER = process.env.GRACE_PYTHON_VER ?? '-3.12';

// Read a document's text — plain formats directly; PDF/DOCX via Python (pypdf / python-docx).
registerTool({
  name: 'read_document',
  description: "Read a document's text: plain text/markdown/csv/code/html directly, PDF via pypdf, and .docx via python-docx (if installed). Use to read a document before summarizing or answering about it.",
  params: {
    path: { type: 'string', description: 'absolute path to the document', required: true },
    maxChars: { type: 'number', description: 'max characters to return (default 8000, max 40000)' },
  },
  async run(args) {
    const p = path.resolve(String(args.path ?? ''));
    if (!fs.existsSync(p)) return { error: `file not found: ${p}` };
    const cap = Math.max(500, Math.min(40000, Number(args.maxChars) || 8000));
    const ext = path.extname(p).toLowerCase();
    const pyArgs = (code: string) => [...(PY_VER ? [PY_VER] : []), '-c', code, p];
    try {
      if (ext === '.pdf') {
        const code = "import sys\ntry:\n from pypdf import PdfReader\nexcept Exception:\n from PyPDF2 import PdfReader\nr=PdfReader(sys.argv[1])\nprint('\\n'.join((pg.extract_text() or '') for pg in r.pages))";
        const out = execFileSync(PY, pyArgs(code), { timeout: 30_000, maxBuffer: 20 * 1024 * 1024 }).toString();
        return { path: p, type: 'pdf', chars: out.length, text: out.slice(0, cap) };
      }
      if (ext === '.docx') {
        const code = "import sys\nfrom docx import Document\nd=Document(sys.argv[1])\nprint('\\n'.join(par.text for par in d.paragraphs))";
        const out = execFileSync(PY, pyArgs(code), { timeout: 30_000, maxBuffer: 20 * 1024 * 1024 }).toString();
        return { path: p, type: 'docx', chars: out.length, text: out.slice(0, cap) };
      }
      // Read only a bounded prefix — never load an 800 MB log/csv into a string (which also blocked
      // the event loop and threw on >2 GiB files). 4 MB is ample for `cap` chars even after HTML stripping.
      const READ_CAP = 4 * 1024 * 1024;
      const size = fs.statSync(p).size;
      let raw: string;
      if (size <= READ_CAP) {
        raw = fs.readFileSync(p, 'utf8');
      } else {
        const fd = fs.openSync(p, 'r');
        try { const buf = Buffer.alloc(READ_CAP); const n = fs.readSync(fd, buf, 0, READ_CAP, 0); raw = buf.subarray(0, n).toString('utf8'); }
        finally { fs.closeSync(fd); }
      }
      const text = (ext === '.html' || ext === '.htm') ? htmlToText(raw, cap) : raw.slice(0, cap);
      return { path: p, type: ext.slice(1) || 'text', chars: raw.length, text, ...(size > READ_CAP ? { truncated: `read first 4 MB of ${(size / 1e6).toFixed(0)} MB` } : {}) };
    } catch (e) {
      if (ext === '.pdf') return { path: p, error: `PDF read failed — install pypdf (py ${PY_VER} -m pip install pypdf). ${String(e).slice(0, 120)}` };
      if (ext === '.docx') return { path: p, error: `DOCX read failed — install python-docx (py ${PY_VER} -m pip install python-docx). ${String(e).slice(0, 120)}` };
      return { path: p, error: String(e).slice(0, 200) };
    }
  },
});
