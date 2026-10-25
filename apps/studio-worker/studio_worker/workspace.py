"""A design's workspace (its working files, the agents' own session homes and the conversation) as one tar.gz that
VLM's API keeps between machine starts."""
import io
import json
import os
import subprocess
import tarfile
from dataclasses import asdict, dataclass, field
from pathlib import Path, PurePosixPath

from .config import AGENT_USER

STATE = Path('.studio/state.json')
# The image installs the skills into the workspace; saving them with a design would pin it to an old skills SHA
IMAGE_OWNED = ('.claude/skills', '.agents/skills')


@dataclass
class State:
    sessions: dict[str, str] = field(default_factory=dict)  # agent -> session id
    totals: dict[str, dict] = field(default_factory=dict)  # agent -> its session's running Usage, as a dict
    messages: list[dict] = field(default_factory=list)  # {'role': 'user'|'agent', 'agent': str, 'text': str}
    last_agent: str | None = None
    hashes: dict[str, dict[str, str]] = field(default_factory=dict)  # category -> {glb name: sha256}


def pack(design: Path) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w:gz') as tar:
        for path in sorted(Path(design).rglob('*')):
            rel = path.relative_to(design).as_posix()
            if any(rel == d or rel.startswith(d + '/') for d in IMAGE_OWNED):
                continue
            tar.add(path, arcname=rel, recursive=False)
    return buf.getvalue()


def unpack(data: bytes, design: Path) -> None:
    """Restores a workspace. Every member must stay inside `design`; one that doesn't fails the whole restore
    before anything is written."""
    design = Path(design)
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as tar:
        members = tar.getmembers()
        for m in members:
            if not _inside(m.name) or (m.issym() or m.islnk()) and not _inside(m.linkname, PurePosixPath(m.name).parent):
                raise ValueError(f'workspace member escapes the design: {m.name}')
            if not (m.isfile() or m.isdir() or m.issym() or m.islnk()):
                raise ValueError(f'workspace member is not a file or directory: {m.name}')
        design.mkdir(parents=True, exist_ok=True)
        for m in members:
            m.uid = m.gid = 0
            m.uname = m.gname = ''
        tar.extractall(design, members=members)
    if os.geteuid() == 0:
        subprocess.run(['chown', '-R', AGENT_USER, str(design)], check=False)


def _inside(name: str, base: PurePosixPath = PurePosixPath('.')) -> bool:
    p = PurePosixPath(name)
    if p.is_absolute():
        return False
    depth = len([x for x in base.parts if x not in ('', '.')])
    for part in p.parts:
        depth += -1 if part == '..' else 0 if part in ('', '.') else 1
        if depth < 0:
            return False
    return True


def load_state(design: Path) -> State:
    path = Path(design) / STATE
    if not path.exists():
        return State()
    return State(**json.loads(path.read_text()))


def save_state(design: Path, state: State) -> None:
    path = Path(design) / STATE
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(asdict(state), indent=2))


def prompt_with_context(state: State, agent: str, words: str) -> str:
    """The prompt for `agent`. When the conversation moved on without it, it gets what was said since its own last
    turn (its session already holds its earlier turns), then the user's words."""
    if state.last_agent in (None, agent):
        return words
    own = [i for i, m in enumerate(state.messages) if m.get('agent') == agent]
    missed = state.messages[own[-1] + 1:] if own else state.messages
    if not missed:
        return words
    lines = [f"{'User' if m['role'] == 'user' else m['agent'].capitalize()}: {m['text']}" for m in missed]
    return 'Conversation so far:\n' + '\n\n'.join(lines) + '\n\nThe user now says:\n' + words
