"""The studio's fixed instruction, appended to every prompt after the user's words."""
from .config import ASSETS

LAYOUT = """Write each piece to its own folder, out/<category>/ (for example out/hat/), holding:
- its GLBs: <name>_male.glb and <name>_female.glb, or one <name>.glb for an emote or a piece that fits both body shapes;
- piece.json: {"name": str, "description": str, "category": str, "hides": [str], "replaces": [str], "tags": [str],
  "changeKind": "new" | "fix" | "design"%s}.
Nothing else goes in out/. To change a piece, export over its files; leave a piece you didn't change as it is."""


def closing(kind: str, selected_slots: list[str] | None) -> str:
    if kind == 'emote':
        what = 'Build one Decentraland emote. Its folder is out/emote/.'
        layout = LAYOUT % ', "loop": true | false'
        look = ('Before you finish, run `studio-preview out/emote` and open the images it prints: check the hands, '
                'limbs and props through the animation and fix any clipping you see.')
        check = 'Run the emote checker (check_emote.py) on the GLB and fix every FAIL.'
    else:
        what = (f'Build only these slots: {", ".join(selected_slots)}.' if selected_slots else
                'If the idea is settled enough to build, build it.')
        layout = (LAYOUT % ', "rarity": "common" | "uncommon" | "rare" | "epic" | "legendary" | "exotic" | "mythic" | "unique"'
                  + '\nName, describe (at most 64 characters), tag and pick a rarity for each piece with the '
                  'listing-dcl-wearables skill.')
        look = ('Before you finish, run `studio-preview out/<category>` for each piece and open the four views it '
                'prints (front, right, back, left) for each body shape. Fix any clipping you see, such as hair '
                'poking through a hat; if a hat would look better hiding the hair, ask the user rather than guess.')
        check = 'Run the wearable checker (check_wearable.py) with the piece\'s category and hides, and fix every FAIL.'
    shaping = ('' if kind == 'emote' or selected_slots else
               '\nIf the concept is not settled yet (no slots are selected and the idea could go several ways), do not '
               'build: shape it with the shaping-dcl-item-ideas skill and write out/proposal.json instead, as '
               '{"slots": [{"category": str, "recommended": true | false, "reason": str}]}, then ask the user which '
               'slots to build.')
    return f"""

---
Studio instructions:
Use the dcl-avatar-skills. The official Decentraland base avatar .blend files are in {ASSETS}. Blender runs headless
only: `blender -b`. {what}
{layout}
Blender is for building only: never render in Blender (no thumbnails, turntables or test renders). `studio-preview` is how you look at your work.
{look}
{check}{shaping}
When you're done, reply to the user in a few plain sentences: what you made or changed, and anything you need from them."""
