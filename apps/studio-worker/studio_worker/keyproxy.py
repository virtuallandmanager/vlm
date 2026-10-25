"""A loopback proxy that adds the real API key, so the agents never hold one.

Runs as its own `keyproxy` user (the agent can't read its environment) on 127.0.0.1: Anthropic on 8890, OpenAI on
8891. Each request is forwarded unchanged to the provider through the allowlisting proxy, with the client's key
headers replaced by the real one, and the response is streamed back as it arrives (server-sent events included).
Nothing about a request is ever logged.
"""
import http.client
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

ANTHROPIC_PORT, OPENAI_PORT = 8890, 8891
UPSTREAM_TIMEOUT_SEC = 900  # between reads; an agent's stream can sit quiet while the model thinks
CHUNK = 65536
# Hop-by-hop headers, and the ones this proxy sets itself
DROP = {'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer',
        'transfer-encoding', 'upgrade', 'host', 'content-length', 'x-api-key', 'authorization'}


def _handler(upstream: str, header: str, key: str, proxy: str | None):
    up = urlsplit(upstream)
    via = urlsplit(proxy) if proxy else None

    def connect() -> http.client.HTTPConnection:
        if via:  # CONNECT through tinyproxy, then TLS to the provider
            c = http.client.HTTPSConnection(via.hostname, via.port or 8888, timeout=UPSTREAM_TIMEOUT_SEC)
            c.set_tunnel(up.hostname, up.port or 443)
            return c
        cls = http.client.HTTPSConnection if up.scheme == 'https' else http.client.HTTPConnection
        return cls(up.hostname, up.port, timeout=UPSTREAM_TIMEOUT_SEC)

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *args):  # never log a request
            pass

        def _body(self) -> bytes:
            if 'chunked' in (self.headers.get('transfer-encoding') or '').lower():
                out = bytearray()
                while True:
                    size = int(self.rfile.readline().split(b';')[0].strip() or b'0', 16)
                    if size == 0:
                        while self.rfile.readline() not in (b'\r\n', b'\n', b''):
                            pass
                        return bytes(out)
                    out += self.rfile.read(size)
                    self.rfile.readline()
            return self.rfile.read(int(self.headers.get('content-length') or 0))

        def _forward(self):
            body = self._body()
            headers = {k: v for k, v in self.headers.items() if k.lower() not in DROP}
            headers['Host'] = up.netloc
            headers[header] = f'Bearer {key}' if header == 'authorization' else key
            if body or self.command in ('POST', 'PUT', 'PATCH'):
                headers['Content-Length'] = str(len(body))
            try:
                conn = connect()
                conn.request(self.command, (up.path.rstrip('/') + self.path) or '/', body=body or None, headers=headers)
                resp = conn.getresponse()
            except Exception as err:  # the provider is unreachable: say so without echoing anything sent
                msg = f'{{"error":"key proxy could not reach the provider: {type(err).__name__}"}}'.encode()
                self.send_response(502)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(msg)))
                self.end_headers()
                self.wfile.write(msg)
                return
            try:
                self.send_response(resp.status, resp.reason)
                length = resp.getheader('content-length')
                for k, v in resp.getheaders():
                    if k.lower() not in DROP:
                        self.send_header(k, v)
                if length is not None:
                    self.send_header('Content-Length', length)
                else:
                    self.send_header('Transfer-Encoding', 'chunked')
                self.end_headers()
                while chunk := resp.read1(CHUNK):
                    if length is not None:
                        self.wfile.write(chunk)
                    else:
                        self.wfile.write(b'%x\r\n%s\r\n' % (len(chunk), chunk))
                    self.wfile.flush()
                if length is None:
                    self.wfile.write(b'0\r\n\r\n')
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True
            finally:
                conn.close()

        do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _forward

    return Handler


def serve(port: int, upstream: str, header: str, key: str, proxy: str | None) -> ThreadingHTTPServer:
    srv = ThreadingHTTPServer(('127.0.0.1', port), _handler(upstream, header, key, proxy))
    srv.daemon_threads = True
    return srv


def main() -> None:
    proxy = os.environ.get('HTTPS_PROXY') or None
    servers = [
        serve(ANTHROPIC_PORT, 'https://api.anthropic.com', 'x-api-key', os.environ.get('ANTHROPIC_API_KEY', ''), proxy),
        serve(OPENAI_PORT, 'https://api.openai.com', 'authorization', os.environ.get('OPENAI_API_KEY', ''), proxy),
    ]
    for k in ('ANTHROPIC_API_KEY', 'OPENAI_API_KEY'):
        os.environ.pop(k, None)
    threads = [threading.Thread(target=s.serve_forever, daemon=True) for s in servers]
    for t in threads:
        t.start()
    print('keyproxy: listening on 127.0.0.1:8890 and 127.0.0.1:8891', file=sys.stderr, flush=True)
    for t in threads:
        t.join()


if __name__ == '__main__':
    main()
