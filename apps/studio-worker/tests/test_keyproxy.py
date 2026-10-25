import http.client
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from studio_worker import keyproxy


class Upstream(BaseHTTPRequestHandler):
    seen: list[dict] = []
    mode = 'ok'

    def log_message(self, *a):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('content-length') or 0))
        Upstream.seen.append({'path': self.path, 'headers': {k.lower(): v for k, v in self.headers.items()}, 'body': body})
        if Upstream.mode == 'stream':
            self.send_response(200)
            self.send_header('content-type', 'text/event-stream')
            self.end_headers()
            self.wfile.write(b'data: 1\n\n')
            self.wfile.flush()
            time.sleep(1)
            self.wfile.write(b'data: 2\n\n')
            self.wfile.flush()
            return
        if Upstream.mode == 'limited':
            data = b'{"error":{"type":"rate_limit_error"}}'
            self.send_response(429)
            self.send_header('content-type', 'application/json')
            self.send_header('content-length', str(len(data)))
            self.send_header('retry-after', '7')
            self.end_headers()
            self.wfile.write(data)
            return
        data = b'{"ok":true}'
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


@pytest.fixture
def upstream():
    Upstream.seen, Upstream.mode = [], 'ok'
    srv = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f'http://127.0.0.1:{srv.server_address[1]}'
    srv.shutdown()


def proxy(upstream, header='x-api-key', key='real-key'):
    srv = keyproxy.serve(0, upstream, header, key, None)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def post(srv, headers, path='/v1/messages?beta=true', body=b'{"model":"m"}'):
    c = http.client.HTTPConnection('127.0.0.1', srv.server_address[1], timeout=5)
    c.request('POST', path, body=body, headers={'content-type': 'application/json', **headers})
    return c, c.getresponse()


def test_proxy_swaps_the_key(upstream):
    srv = proxy(upstream)
    _, r = post(srv, {'x-api-key': 'studio-proxy', 'anthropic-version': '2023-06-01'})
    assert r.status == 200 and r.read() == b'{"ok":true}'
    seen = Upstream.seen[0]
    assert seen['headers']['x-api-key'] == 'real-key'
    assert seen['headers']['anthropic-version'] == '2023-06-01'
    assert seen['path'] == '/v1/messages?beta=true' and seen['body'] == b'{"model":"m"}'
    assert 'studio-proxy' not in repr(seen)
    srv.shutdown()


def test_proxy_sets_a_bearer_for_openai(upstream):
    srv = proxy(upstream, header='authorization', key='sk-real')
    post(srv, {'authorization': 'Bearer studio-proxy', 'x-api-key': 'studio-proxy'})[1].read()
    seen = Upstream.seen[0]['headers']
    assert seen['authorization'] == 'Bearer sk-real' and 'x-api-key' not in seen
    srv.shutdown()


def test_proxy_streams_without_buffering(upstream):
    Upstream.mode = 'stream'
    srv = proxy(upstream)
    start = time.monotonic()
    _, r = post(srv, {'x-api-key': 'studio-proxy'})
    assert r.status == 200
    first = r.read1(64) if hasattr(r, 'read1') else r.fp.readline()
    assert b'data: 1' in first
    assert time.monotonic() - start < 0.5
    assert b'data: 2' in r.read()
    srv.shutdown()


def test_proxy_passes_status_and_body(upstream):
    Upstream.mode = 'limited'
    srv = proxy(upstream)
    _, r = post(srv, {'x-api-key': 'studio-proxy'})
    assert r.status == 429
    assert r.getheader('retry-after') == '7'
    assert r.read() == b'{"error":{"type":"rate_limit_error"}}'
    srv.shutdown()


def test_proxy_answers_502_when_upstream_is_down():
    srv = proxy('http://127.0.0.1:9')
    _, r = post(srv, {'x-api-key': 'studio-proxy'})
    assert r.status == 502
    assert b'real-key' not in r.read()
    srv.shutdown()


def test_proxy_forwards_only_the_agents_endpoints(upstream):
    srv = keyproxy.serve(0, upstream, 'authorization', 'sk-real', None, allowed=keyproxy.OPENAI_PATHS)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    for path in ('/v1/files', '/v1/fine_tuning/jobs', '/v1/batches', '/v1/responsesX', '/v1/../v1/files', '/'):
        _, r = post(srv, {'authorization': 'Bearer studio-proxy'}, path=path)
        assert r.status == 403, path
        assert b'sk-real' not in r.read()
    assert Upstream.seen == []
    for path in ('/v1/responses', '/v1/responses/resp_1/cancel', '/v1/models?limit=1'):
        _, r = post(srv, {'authorization': 'Bearer studio-proxy'}, path=path)
        assert r.status == 200, path
        r.read()
    assert keyproxy.allowed_path('/v1/messages?beta=true', keyproxy.ANTHROPIC_PATHS)
    assert keyproxy.allowed_path('/v1/messages/count_tokens', keyproxy.ANTHROPIC_PATHS)
    assert not keyproxy.allowed_path('/v1/messages/batches', keyproxy.ANTHROPIC_PATHS)
    assert not keyproxy.allowed_path('/v1/files', keyproxy.ANTHROPIC_PATHS)
    srv.shutdown()
