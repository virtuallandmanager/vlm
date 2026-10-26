"""The worker's client for VLM's API (CONTRACT.md). Standard library only.

Calls are retried 3 times on 5xx and connection errors; posting a job's result is retried until it succeeds or
RESULT_RETRY_SEC pass, because a lost result leaves the design waiting. Errors never carry the token."""
import json
import time
import urllib.error
import urllib.request
from urllib.parse import quote

RETRIES = 3
RESULT_RETRY_SEC = 600
TIMEOUT_SEC = 60


class ApiError(Exception):
    def __init__(self, method: str, path: str, status: int | None, reason: str):
        super().__init__(f'{method} {path}: {status or reason}')
        self.status = status


class Api:
    def __init__(self, base_url: str, token: str, design_id: str, backoff: float = 2.0):
        self.base = base_url.rstrip('/') + '/api/studio/worker'
        self._token = token
        self.design = design_id
        self.backoff = backoff

    def __repr__(self):  # never the token
        return f'Api({self.base!r}, design={self.design!r})'

    def get_workspace(self) -> bytes | None:
        status, body = self._call('GET', f'/designs/{quote(self.design)}/workspace', ok_missing=True)
        return None if status == 404 else body

    def put_workspace(self, data: bytes) -> None:
        self._call('PUT', f'/designs/{quote(self.design)}/workspace', data, 'application/gzip')

    def next_job(self) -> dict | None:
        status, body = self._call('GET', f'/designs/{quote(self.design)}/jobs/next')
        return json.loads(body) if status == 200 and body else None

    def event(self, job_id: str, event: dict) -> None:
        self._call('POST', f'/jobs/{quote(job_id)}/events', json.dumps(event).encode(), 'application/json')

    def put_file(self, job_id: str, path: str, data: bytes, content_type: str) -> None:
        self._call('PUT', f'/jobs/{quote(job_id)}/files/{quote(path)}', data, content_type)

    def get_input(self, job_id: str, path: str) -> bytes:
        """One of a finalize job's input files: the paid revision's own bytes."""
        return self._call('GET', f'/jobs/{quote(job_id)}/inputs/{quote(path)}')[1]

    def post_result(self, job_id: str, result: dict) -> None:
        deadline = time.monotonic() + RESULT_RETRY_SEC
        while True:
            try:
                self._call('POST', f'/jobs/{quote(job_id)}/result', json.dumps(result).encode(), 'application/json')
                return
            except ApiError as e:
                if e.status and e.status < 500 or time.monotonic() > deadline:
                    raise
                time.sleep(max(self.backoff, 0.01))

    def _call(self, method: str, path: str, data: bytes | None = None, content_type: str | None = None,
              ok_missing: bool = False) -> tuple[int, bytes]:
        headers = {'Authorization': f'Bearer {self._token}'}
        if content_type:
            headers['Content-Type'] = content_type
        for attempt in range(RETRIES):
            req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=TIMEOUT_SEC) as resp:
                    return resp.status, resp.read()
            except urllib.error.HTTPError as e:
                if e.code == 404 and ok_missing:
                    return 404, b''
                error = ApiError(method, path, e.code, e.reason)
                if e.code < 500:
                    raise error from None
            except (urllib.error.URLError, OSError) as e:
                error = ApiError(method, path, None, str(getattr(e, 'reason', e)))
            if attempt < RETRIES - 1:
                time.sleep(self.backoff * (attempt + 1))
        raise error
