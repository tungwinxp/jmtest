"""Local inference only. Start with sh start.sh; Ctrl-C stops and frees the model.

No tool execution, file access API, cloud inference, or arbitrary model loading.
Model artifacts and dependencies are pinned and cached inside this project.
"""
import fcntl
import gc
import json
import os
from pathlib import Path
import re
import resource
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parent
os.environ.setdefault('HF_HOME', str(ROOT / '.cache/huggingface'))
MODEL_ID = 'TheStageAI/gemma-4-E2B-it'
REVISION = 'da722787240d2e78864709425fef40da3790e2a0'
ORIGINS = {'https://tungwinxp.github.io', 'http://127.0.0.1:8771', 'http://localhost:8771'}
work = threading.Lock()
cancel = threading.Event()
model = tokenizer = cache = None
cached_ids = []
active_id = None
last_used = time.monotonic()


def ensure_model():
    global model, tokenizer
    if model is None:
        from huggingface_hub import snapshot_download
        from edge_lm.models.load import load, set_prefill_logits_to_keep
        directory = snapshot_download(MODEL_ID, revision=REVISION, allow_patterns=[
            'config.json', 'model_m.safetensors', 'ple_m.safetensors',
            'tokenizer.json', 'tokenizer_config.json'])
        model, tokenizer = load(directory, size='m')
        set_prefill_logits_to_keep(model, 1)


def unload():
    global model, tokenizer, cache, cached_ids
    if model is None:
        cache = None; cached_ids = []; return
    import mlx.core as mx
    model = tokenizer = cache = None; cached_ids = []
    gc.collect(); mx.clear_cache()


def release_idle():
    # A crashed tab may never send pagehide. No inference runs in this thread.
    while True:
        threading.Event().wait(5)
        if model is not None and time.monotonic() - last_used >= 60 and work.acquire(False):
            try:
                if time.monotonic() - last_used >= 60: unload()
            finally:
                work.release()


def completion(body):
    global cache, cached_ids
    import mlx.core as mx
    from mlx_vlm import stream_generate
    from mlx_vlm.tools.parsers.gemma4 import parse_tool_call
    ensure_model()
    messages = body.get('messages')
    if not isinstance(messages, list) or not 1 <= len(messages) <= 24:
        raise ValueError('Supply 1–24 messages.')
    messages = json.loads(json.dumps(messages))
    names = {}
    for message in messages:
        if message.get('role') not in ('system', 'user', 'assistant', 'tool'):
            raise ValueError('Unsupported message role.')
        for call in message.get('tool_calls', []):
            function = call['function']
            names[call.get('id')] = function['name']
            if isinstance(function['arguments'], str):
                function['arguments'] = json.loads(function['arguments'])
        if message['role'] == 'tool':
            message['name'] = names.get(message.get('tool_call_id'), 'tool')
    tools = body.get('tools') or []
    prompt = tokenizer.apply_chat_template(messages, tools=tools, tokenize=False,
                                          add_generation_prompt=True, enable_thinking=False)
    ids = tokenizer.encode(prompt)
    if len(ids) + 128 > 4096:
        raise ValueError('This command exceeds the 4096-token guide budget. Split it into smaller commands.')
    reused = len(cached_ids) if cache is not None and ids[:len(cached_ids)] == cached_ids else 0
    if not reused:
        cache = model.language_model.make_cache()
    new_ids = ids[reused:]
    if not new_ids:
        cache = model.language_model.make_cache(); new_ids = ids; reused = 0
    mx.random.seed(0)
    parts, tokens, last = [], [], None
    started = time.perf_counter()
    for result in stream_generate(model, tokenizer, '',
            input_ids=mx.array([new_ids], dtype=mx.int32), prompt_cache=cache,
            temperature=0, max_tokens=max(1, min(128, int(body.get('max_tokens', 128)))),
            prefill_step_size=256):
        if cancel.is_set():
            cache = None; cached_ids = []
            raise InterruptedError('Generation stopped.')
        parts.append(result.text); tokens.append(result.token); last = result
    cached_ids = ids + tokens[:-1]
    text = ''.join(parts)
    calls = []
    for index, span in enumerate(re.findall(r'<\|tool_call>(.*?)<tool_call\|>', text, re.S)):
        function = parse_tool_call(span, tools)
        if function['name'] not in {t['function']['name'] for t in tools}:
            raise ValueError('The model selected an unavailable tool.')
        calls.append({'id': f'{active_id}-{index}', 'type': 'function', 'function': function})
    if '<|tool_call>' in text and not calls:
        raise ValueError('The model returned an incomplete tool call. Retry the message.')
    content = re.sub(r'<\|tool_call>.*?<tool_call\|>', '', text, flags=re.S)
    content = re.sub(r'<\|[^<>]+\|?>', '', content).strip()
    elapsed = time.perf_counter() - started
    return {'choices': [{'index': 0, 'finish_reason': 'tool_calls' if calls else 'stop',
                         'message': {'role': 'assistant', 'content': content, **({'tool_calls': calls} if calls else {})}}],
            'model': MODEL_ID, 'backend': 'mlx',
            'usage': {'prompt_tokens': len(ids), 'completion_tokens': last.generation_tokens,
                      'prompt_tokens_details': {'cached_tokens': reused}},
            'timings': {'prompt_per_second': last.prompt_tps, 'predicted_per_second': last.generation_tps,
                        'elapsed_ms': elapsed * 1000, 'peak_memory_gb': last.peak_memory,
                        'process_peak_rss_bytes': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}}


class Handler(BaseHTTPRequestHandler):
    def permitted(self):
        return self.headers.get('Host') in ('127.0.0.1:18773', 'localhost:18773') and self.headers.get('Origin') in (None, *ORIGINS)

    def reply(self, status, body=None):
        data = json.dumps(body).encode() if body is not None else b''
        self.send_response(status)
        origin = self.headers.get('Origin')
        if origin in ORIGINS:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-JMFS-Guide')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Cross-Origin-Resource-Policy', 'cross-origin')
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_OPTIONS(self):
        self.reply(204 if self.permitted() else 403)

    def do_GET(self):
        if not self.permitted(): return self.reply(403, {'error': 'Origin or host rejected.'})
        if self.path != '/health': return self.reply(404)
        self.reply(200, {'backend': 'mlx', 'model': MODEL_ID, 'size': 'm', 'model_gb': 1.44,
                         'loaded': model is not None, 'busy': work.locked()})

    def do_POST(self):
        global active_id, model, tokenizer, cache, cached_ids, last_used
        if not self.permitted() or self.headers.get('X-JMFS-Guide') != '1': return self.reply(403)
        try: length = int(self.headers.get('Content-Length', '0'))
        except ValueError: return self.reply(400, {'error': 'Invalid content length.'})
        if not 0 < length <= 1_000_000: return self.reply(413)
        try:
            body = json.loads(self.rfile.read(length))
        except ValueError:
            return self.reply(400, {'error': 'Invalid JSON.'})
        if not isinstance(body, dict): return self.reply(400, {'error': 'Supply a JSON object.'})
        if self.path == '/cancel':
            if body.get('request_id') == active_id: cancel.set()
            return self.reply(200, {})
        if self.path == '/release':
            if active_id and body.get('request_id') != active_id:
                return self.reply(409, {'error': 'Another native request is active.'})
            cancel.set()
            if not work.acquire(timeout=15): return self.reply(409, {'error': 'The native request is still stopping.'})
            try:
                unload(); return self.reply(200, {})
            finally:
                work.release()
        if self.path not in ('/v1/chat/completions', '/load', '/unload'): return self.reply(404)
        if not work.acquire(blocking=False): return self.reply(409, {'error': 'The native guide is already working.'})
        try:
            cancel.clear(); active_id = body.get('request_id')
            if self.path == '/load':
                ensure_model(); result = {'backend': 'mlx'}
            elif self.path == '/unload':
                unload(); result = {}
            else:
                result = completion(body)
            self.reply(200, result)
        except Exception as error:
            self.reply(400, {'error': str(error)})
        finally:
            active_id = None; last_used = time.monotonic(); work.release()

    def log_message(self, *_):
        pass


if __name__ == '__main__':
    lock = open(ROOT / 'server.lock', 'w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit('The native JMFS guide is already running.')
    print('JMFS native MLX guide: http://127.0.0.1:18773 · Ctrl-C to stop', flush=True)
    threading.Thread(target=release_idle, daemon=True).start()
    ThreadingHTTPServer(('127.0.0.1', 18773), Handler).serve_forever()
