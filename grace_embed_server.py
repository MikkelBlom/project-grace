#!/usr/bin/env python3
"""
grace_embed_server.py — off-GPU embedding server for Grace's memory.

Runs a multilingual embedder (e5 by default) on CPU/ONNX via fastembed, so embeddings stop evicting
the LLM from the RTX (the documented latency root cause). Exposes the contract semanticMemory expects:
    POST /embed  {"input": "text"}  ->  {"embedding": [float, ...]}
    GET  /health                    ->  {"status": "ok", "model": "..."}

Setup:
    py -3.12 -m pip install fastembed
    py -3.12 grace_embed_server.py --model intfloat/multilingual-e5-base --port 8770
Then point Grace at it:
    set GRACE_EMBED_URL=http://localhost:8770     (in start-grace.ps1)
Note: changing the embedder/dimension needs a one-time memory re-index (see docs/6-MODEL-UPGRADES.md).
"""
import sys
import json
import argparse
from http.server import HTTPServer, BaseHTTPRequestHandler

parser = argparse.ArgumentParser()
parser.add_argument('--model', default='intfloat/multilingual-e5-base', help='fastembed model name')
parser.add_argument('--port', type=int, default=8770)
args = parser.parse_args()

print(f"[embed] loading {args.model} (fastembed, CPU)...", file=sys.stderr)
from fastembed import TextEmbedding  # noqa: E402

model = TextEmbedding(model_name=args.model)
list(model.embed(["ready"]))  # warm up
print(f"[embed] ready on :{args.port}", file=sys.stderr)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, code, data):
        body = json.dumps(data).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/health':
            self._json(200, {"status": "ok", "model": args.model})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != '/embed':
            self._json(404, {"error": "not found"})
            return
        try:
            n = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(n))
            text = body.get('input') or body.get('text') or ''
            # e5 expects a "query:"/"passage:" prefix; default to query for retrieval symmetry.
            if not str(text).startswith(('query:', 'passage:')):
                text = 'query: ' + str(text)
            emb = list(model.embed([text]))[0]
            self._json(200, {"embedding": [float(x) for x in emb]})
        except Exception as e:
            self._json(500, {"error": str(e)})


if __name__ == '__main__':
    HTTPServer(('127.0.0.1', args.port), Handler).serve_forever()
