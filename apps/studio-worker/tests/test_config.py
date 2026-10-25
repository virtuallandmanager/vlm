import subprocess

from studio_worker import config


def test_skills_sha_reads_a_root_owned_repo(tmp_path):
    repo = tmp_path / 'skills'
    repo.mkdir()
    git = ['git', '-C', str(repo), '-c', 'user.email=t@t', '-c', 'user.name=t']
    subprocess.run(git[:3] + ['init', '-q'], check=True)
    (repo / 'a').write_text('a')
    subprocess.run(git + ['add', 'a'], check=True)
    subprocess.run(git + ['commit', '-qm', 'a'], check=True)
    head = subprocess.run(['git', '-C', str(repo), 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()
    assert config.skills_sha(repo) == head
    assert config.skills_sha(tmp_path / 'missing') is None
