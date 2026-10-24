import json, os, sys
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
MEDIA = sys.argv[1]
B = "http://127.0.0.1:8787/media/"
def inst(sk, p, r=(0,0,0), s=(1,1,1)):
    return {"sk": sk, "position": dict(zip("xyz", p)), "rotation": dict(zip("xyz", r)), "scale": dict(zip("xyz", s))}
SCENE = {
  "images": [{"sk": "img", "textureSrc": B + "tex.png", "instances": [inst("a", (6, 1.5, 11), s=(2, 2, 1)), inst("b", (10.5, 1.5, 10), (0, 30, 0), (2, 2, 1))]}],
  "models": [{"sk": "duck", "modelSrc": B + "Duck.glb", "instances": [inst("d", (6.3, 0, 8.5), (0, 0, 0), (1.5, 1.5, 1.5))]},
             {"sk": "missing", "modelSrc": B + "nope.glb", "instances": [inst("m", (9.5, 0, 8))]}],
  "videos": [], "sounds": [],
}
class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=MEDIA, **k)
    def do_GET(self):
        if self.path.startswith("/api/hyperfy/feed"):
            if "since=fixture1" in self.path: __import__("time").sleep(25)
            body = json.dumps({"v": 1, "version": "fixture1", "scene": SCENE}).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(body); return
        if self.path.startswith("/media/"): self.path = self.path[len("/media"):]
        return super().do_GET()
ThreadingHTTPServer(("127.0.0.1", 8787), H).serve_forever()
