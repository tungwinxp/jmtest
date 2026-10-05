"""Local inference only. Start with sh start.sh; Ctrl-C stops and frees the model.

No tool execution, file access API, cloud inference, or arbitrary model loading.
Model artifacts and dependencies are pinned and cached inside this project.
"""
import fcntl
import ast
import gc
import json
import os
from pathlib import Path
import re
import resource
import threading
import time
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parent
os.environ.setdefault('HF_HOME', str(ROOT / '.cache/huggingface'))
MODEL_ID = 'mlx-community/MiniCPM5-1B-4bit'
REVISION = '36447e84d28c57588a6e91907675e44afe54ab00'
# One chunk covers a whole guide prompt; cancellation is checked between generated tokens.
PREFILL = 2048
# A view call padded with unused settings needs more than the usual 128 tokens to close.
LIMIT = 192
SWITCH = {'true': True, 'yes': True, 'on': True, 'show': True, 'visible': True,
          'false': False, 'no': False, 'off': False, 'hide': False, 'hidden': False}
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
        from mlx_lm import load
        directory = snapshot_download(MODEL_ID, revision=REVISION, allow_patterns=[
            '*.json', 'chat_template.jinja', 'model.safetensors'])
        model, tokenizer = load(directory)


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


def tool_call(text, tools):
    block = re.search(r'<function\b[^>]*>.*?</function>', text, re.S)
    if not block: return None
    node = ET.fromstring(block.group())
    name = node.attrib.get('name')
    definition = next((t['function'] for t in tools if t['function']['name'] == name), None)
    if definition is None: raise ValueError('The model selected an unavailable tool.')
    properties = definition.get('parameters', {}).get('properties', {})
    args = {}
    for param in node:
        key = param.attrib.get('name')
        if param.tag != 'param' or key in args:
            raise ValueError('The guide wrote a malformed tool call. Rephrase the command or send it again.')
        # A small model pads calls with settings the tool never declared; they are dropped here
        # and cannot reach the workbench.
        if key not in properties: continue
        value = param.text or ''
        kind = properties[key].get('type')
        if kind != 'string':
            # An empty non-string value is an omitted parameter, not a setting.
            if not value.strip(): continue
            word = value.strip().lower()
            if kind == 'boolean' and word in SWITCH: value = SWITCH[word]
            else:
                try: value = json.loads(value)
                except ValueError:
                    try: value = ast.literal_eval(value)
                    except (ValueError, SyntaxError): pass  # The agent's schema validation reports it.
        args[key] = value
    return {'name': name, 'arguments': json.dumps(args)}


def completion(body):
    global cache, cached_ids
    import mlx.core as mx
    from mlx_lm import stream_generate
    from mlx_lm.models.cache import can_trim_prompt_cache, make_prompt_cache, trim_prompt_cache
    from mlx_lm.sample_utils import make_sampler
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
    # Commands are ephemeral, so only a shared prefix can be cached. Rendering the tool
    # definitions before the per-command FORM_CONTEXT keeps instructions and tools in it.
    first = messages[0]
    if (tools and first['role'] == 'system' and isinstance(first.get('content'), str)
            and '<tool_def_sep>' not in first['content'] and '<tool_def_sep>' in (tokenizer.chat_template or '')):
        first['content'] = first['content'].replace('\nFORM_CONTEXT: ', '\n\n<tool_def_sep>\n\nFORM_CONTEXT: ', 1)
    prompt = tokenizer.apply_chat_template(messages, tools=tools, tokenize=False,
                                          add_generation_prompt=True, enable_thinking=False)
    ids = tokenizer.encode(prompt, add_special_tokens=False)
    if len(ids) + LIMIT > 4096:
        raise ValueError('This command exceeds the 4096-token guide budget. Split it into smaller commands.')
    # Reuse the longest prefix shared with the previous command and drop the rest of its cache.
    reused = 0
    if cache is not None:
        limit = min(len(cached_ids), len(ids) - 1)
        while reused < limit and cached_ids[reused] == ids[reused]: reused += 1
        if reused < len(cached_ids):
            if reused and can_trim_prompt_cache(cache): trim_prompt_cache(cache, len(cached_ids) - reused)
            else: reused = 0
    if not reused:
        cache = make_prompt_cache(model)
    new_ids = ids[reused:]
    mx.random.seed(0)
    parts, tokens, last = [], [], None
    started = time.perf_counter()
    try:
        for result in stream_generate(model, tokenizer, prompt=new_ids, prompt_cache=cache,
                sampler=make_sampler(temp=0), max_tokens=max(1, min(LIMIT, int(body.get('max_tokens', 128)))),
                prefill_step_size=PREFILL):
            if cancel.is_set(): raise InterruptedError('Generation stopped.')
            parts.append(result.text); tokens.append(result.token); last = result
            if '</function>' in ''.join(parts): break
    except BaseException:
        # A partly filled cache no longer matches cached_ids.
        cache = None; cached_ids = []
        raise
    # MLX can prefetch the next token before yielding. Use the actual cache
    # length, including when generation stops at the first completed function.
    cached_ids = (ids + tokens)[:cache[0].offset]
    text = ''.join(parts)
    function = tool_call(text, tools)
    calls = [{'id': f'{active_id}-0', 'type': 'function', 'function': function}] if function else []
    if '<function' in text and not calls:
        raise ValueError('The model returned an incomplete tool call. Retry the message.')
    content = re.sub(r'<function\b[^>]*>.*?</function>', '', text, flags=re.S)
    content = re.sub(r'<think>.*?</think>', '', content, flags=re.S)
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
        self.reply(200, {'backend': 'mlx', 'model': MODEL_ID, 'quantization': '4bit', 'model_gb': 0.618,
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
