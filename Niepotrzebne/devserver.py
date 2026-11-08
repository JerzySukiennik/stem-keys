# Stem Keys: local dev server with caching off, so every reload picks up edited modules.
import functools, http.server, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *a):
        pass


Handler.extensions_map.update({".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml"})
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8987
http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Handler, directory=ROOT)).serve_forever()
