import os
from pathlib import Path

import pytest

from studio_worker import config

FIXTURES = Path(__file__).parent / 'fixtures'
# The skills' checkers: the image has them at /opt/skills; on a laptop, a dcl-avatar-skills checkout
LOCAL_SKILLS = Path(os.environ.get('STUDIO_SKILLS', Path.home() / '-Decentraland/dcl-avatar-skills'))


@pytest.fixture
def skills(monkeypatch):
    repo = config.SKILLS if (config.SKILLS / 'skills').exists() else LOCAL_SKILLS
    if not (repo / 'skills/creating-dcl-wearables/scripts/check_wearable.py').exists():
        pytest.skip('no dcl-avatar-skills checkout (set STUDIO_SKILLS)')
    monkeypatch.setattr(config, 'SKILLS', repo)
    return repo
