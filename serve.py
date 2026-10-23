#!/usr/bin/env python3
"""Dev server: serves this directory, and proxies /pkg/ to the package mirror.

Same-origin is the whole point: a browser fetch of a package from another origin needs CORS, which
the mirror does not send. In production the same reverse proxy sits in front of the static files;
this exists so `python3 serve.py` behaves like production on a laptop.

    python3 serve.py [port]        # http://localhost:8080
    MIRROR=https://example.org python3 serve.py
"""
import functools
import http.server
import os
import sys
import urllib.error
import urllib.request

# Test harness only: in production the page and the packages share an origin and nothing here is
# involved. Local files under /pkg/ win (symlink packages there for fast tests); everything else is
# proxied to the mirror, which sends no CORS headers.
UPSTREAM = os.environ.get("MIRROR", "https://rom.flac.moe")
ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # dev harness: a browser can otherwise reuse an ES module from before the last edit, which
        # looks exactly like "the page ignored my change"
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def local(self):
        return os.path.isfile(os.path.join(ROOT, self.path.split("?")[0].lstrip("/")))

    def do_GET(self):
        if self.path.startswith("/pkg/") and not self.local():
            return self.proxy()
        super().do_GET()

    def do_HEAD(self):
        if self.path.startswith("/pkg/") and not self.local():
            return self.proxy()
        super().do_HEAD()

    def proxy(self):
        upstream = UPSTREAM + self.path[len("/pkg") :]
        req = urllib.request.Request(upstream, headers={"User-Agent": "ougi-flasher-dev/1"})
        if range_header := self.headers.get("Range"):
            req.add_header("Range", range_header)
        try:
            with urllib.request.urlopen(req) as res:
                self.send_response(res.status)
                for header in ("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"):
                    if value := res.headers.get(header):
                        self.send_header(header, value)
                self.end_headers()
                if self.command == "HEAD":
                    return
                while chunk := res.read(64 * 1024):
                    self.wfile.write(chunk)
        except urllib.error.HTTPError as err:
            self.send_error(err.code, err.reason)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    handler = functools.partial(Handler, directory=ROOT)
    with http.server.ThreadingHTTPServer(("", port), handler) as httpd:
        print(f"serving {ROOT} on http://localhost:{port} (proxy: /pkg/ -> {UPSTREAM})")
        httpd.serve_forever()
