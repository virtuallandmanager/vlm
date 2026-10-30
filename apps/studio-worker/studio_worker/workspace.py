"""A design's workspace as one tar.gz that Virvi's API keeps between machine starts: design/, the agent's working
files and session homes, and state/, the worker's own records (conversation, sessions, usage, piece hashes).

The agent owns design/ and can put anything there, so the root worker treats it as hostile: state lives outside it,
and links are never saved or followed."""
import io
import json
import os
import shutil
import stat
import subprocess
import tarfile
from dataclasses import asdict, dataclass, field
from pathlib import Path, PurePosixPath

from .config import AGENT_USER

# The image installs the skills into the workspace; saving them with a design would pin it to an old skills SHA
IMAGE_OWNED = ('.claude/skills', '.agents/skills')
# What a saved workspace leaves out: the image's skills, and the owner's uploads, which come from Virvi with every prompt
NOT_SAVED = (*IMAGE_OWNED, 'uploads')


@dataclass
class State:
    sessions: dict[str, str] = field(default_factory=dict)  # agent -> session id
    totals: dict[str, dict] = field(default_factory=dict)  # agent -> its session's running Usage, as a dict
    messages: list[dict] = field(default_factory=list)  # {'role': 'user'|'agent', 'agent': str, 'text': str}
    last_agent: str | None = None
    hashes: dict[str, dict[str, str]] = field(default_factory=dict)  # category -> {glb name: sha256}


def state_dir(design: Path) -> Path:
    """The worker's own records for a design, beside it: root-owned, out of the agent's reach."""
    return Path(design).with_name(Path(design).name + '-state')


def pack(design: Path, state: Path) -> bytes:
    """A tar.gz of design/ (the agent's files) and state/ (the worker's). Only regular files and directories go
    in: a symlink the agent made is left out, so restoring never follows one."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w:gz') as tar:
        for prefix, root in (('design', Path(design)), ('state', Path(state))):
            for dirpath, dirnames, filenames in os.walk(root):
                rel_dir = Path(dirpath).relative_to(root).as_posix()
                if any(rel_dir == d or rel_dir.startswith(d + '/') for d in NOT_SAVED):
                    dirnames[:] = []
                    continue
                for name in sorted(dirnames) + sorted(filenames):
                    path = Path(dirpath) / name
                    rel = path.relative_to(root).as_posix()
                    if any(rel == d for d in NOT_SAVED):
                        continue
                    st = path.lstat()
                    if stat.S_ISDIR(st.st_mode):
                        tar.add(path, arcname=f'{prefix}/{rel}', recursive=False)
                    elif stat.S_ISREG(st.st_mode):
                        with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as f:
                            info = tar.gettarinfo(arcname=f'{prefix}/{rel}', fileobj=f)
                            tar.addfile(info, f)
    return buf.getvalue()


def unpack(data: bytes, design: Path, state: Path) -> None:
    """Restores a workspace. Only regular files and directories under design/ or state/ are accepted; anything else
    fails the whole restore before anything is written. Files are created without following any existing link."""
    roots = {'design': Path(design), 'state': Path(state)}
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as tar:
        members = tar.getmembers()
        for m in members:
            parts = PurePosixPath(m.name).parts
            if not parts or parts[0] not in roots or any(x in ('..', '') for x in parts) or PurePosixPath(m.name).is_absolute():
                raise ValueError(f'workspace member outside design/ and state/: {m.name}')
            if not (m.isfile() or m.isdir()):
                raise ValueError(f'workspace member is not a file or directory: {m.name}')
        for root in roots.values():
            root.mkdir(parents=True, exist_ok=True)
        for m in members:
            parts = PurePosixPath(m.name).parts
            target = _safe_dir(roots[parts[0]], parts[1:-1] if m.isfile() else parts[1:])
            if m.isfile():
                fd = os.open(target / parts[-1], os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o644)
                with os.fdopen(fd, 'wb') as out:
                    shutil.copyfileobj(tar.extractfile(m), out)
    if os.geteuid() == 0:
        subprocess.run(['chown', '-R', AGENT_USER, str(design)], check=False)


def _safe_dir(root: Path, parts) -> Path:
    """root/parts, created as directories, refusing any component that is already a symlink."""
    path = root
    for part in parts:
        path = path / part
        if os.path.islink(path):
            raise ValueError(f'workspace path runs through a symlink: {path}')
        path.mkdir(exist_ok=True)
    return path


def load_state(state: Path) -> State:
    path = Path(state) / 'state.json'
    if not path.exists():
        return State()
    return State(**json.loads(path.read_text()))


def save_state(state_path: Path, state: State) -> None:
    path = Path(state_path) / 'state.json'
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
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
