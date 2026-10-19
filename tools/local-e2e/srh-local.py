import json, os, redis
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
R = redis.Redis(host='127.0.0.1', port=int(os.environ.get('REDIS_PORT','6390')))
R.response_callbacks.clear()
TOK = os.environ['SRH_TOKEN']
def conv(v):
    if isinstance(v, bytes): return v.decode('utf-8','replace')
    if isinstance(v, (list, tuple)): return [conv(x) for x in v]
    if isinstance(v, dict): return [conv(x) for kv in v.items() for x in kv]
    return v
def run(cmd):
    try: return {"result": conv(R.execute_command(*cmd))}
    except Exception as e: return {"error": str(e)}
class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'  # keep-alive, like real SRH
    def log_message(self,*a): pass
    def do_POST(self):
        if self.headers.get('Authorization') != 'Bearer '+TOK:
            self.send_response(401); self.send_header('Content-Length','0'); self.end_headers(); return
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))) or b'null')
        out = [run(c) for c in body] if self.path.rstrip('/') in ('/pipeline','/multi-exec') else run(body)
        data = json.dumps(out).encode()
        self.send_response(200); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data)
ThreadingHTTPServer(('127.0.0.1', int(os.environ['SRH_PORT'])), H).serve_forever()
