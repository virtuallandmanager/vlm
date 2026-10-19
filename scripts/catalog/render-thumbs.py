# Renders 256x256 catalog thumbnails for models whose source has none, in headless Blender (3.6+):
#
#   blender -b --factory-startup -P scripts/catalog/render-thumbs.py -- <repos-dir> <render-list.json> [limit]
#
# render-list.json (from draft-tags.mjs) is [{ glb, out }] with paths relative to <repos-dir>. Existing outputs are
# skipped, so the run can be stopped and resumed. Re-run draft-tags.mjs afterwards to pick the thumbnails up.
import json
import math
import os
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:]
repos, list_path = argv[0], argv[1]
limit = int(argv[2]) if len(argv) > 2 else None
jobs = json.load(open(list_path))

SIZE = 256
BG = (0.93, 0.93, 0.95, 1)


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    try:
        scene.render.engine = 'BLENDER_EEVEE'
    except TypeError:
        scene.render.engine = 'BLENDER_WORKBENCH'
    scene.render.resolution_x = scene.render.resolution_y = SIZE
    scene.render.image_settings.file_format = 'PNG'
    scene.render.film_transparent = False
    world = bpy.data.worlds.new('w')
    world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == 'BACKGROUND')
    bg.inputs[0].default_value = BG
    bg.inputs[1].default_value = 0.6
    scene.view_settings.view_transform = 'Standard'
    scene.world = world
    return scene


def bounds(objs):
    pts = [o.matrix_world @ Vector(c) for o in objs for c in o.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi


def render(glb, out):
    scene = reset()
    bpy.ops.import_scene.gltf(filepath=glb)
    meshes = []
    for o in scene.objects:
        if o.type != 'MESH':
            continue
        # Decentraland collider meshes (*_collider) are invisible in-world; drawn here they'd hide the model
        if 'collider' in o.name.lower():
            o.hide_render = True
            continue
        meshes.append(o)
    if not meshes:
        raise RuntimeError('no meshes')
    lo, hi = bounds(meshes)
    center = (lo + hi) / 2
    radius = max((hi - lo).length / 2, 0.01)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    scene.collection.objects.link(cam)
    cam.data.lens = 50
    # Three-quarter view from the front (models face -Y once imported), a little to the right and above
    direction = Vector((0.6, -1.4, 0.8)).normalized()
    fov = 2 * math.atan(36 / 2 / cam.data.lens)
    cam.location = center + direction * (radius / math.sin(fov / 2)) * 1.05
    cam.rotation_euler = (center - cam.location).to_track_quat('-Z', 'Y').to_euler()
    cam.data.clip_end = max(1000, radius * 20)
    scene.camera = cam
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.data.energy = 2.5
    sun.rotation_euler = (math.radians(50), 0, math.radians(30))
    scene.collection.objects.link(sun)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    scene.render.filepath = out
    bpy.ops.render.render(write_still=True)


done = failed = 0
for job in jobs:
    out = os.path.join(repos, job['out'])
    if os.path.exists(out):
        continue
    if limit is not None and done + failed >= limit:
        break
    try:
        render(os.path.join(repos, job['glb']), out)
        done += 1
    except Exception as e:  # one bad model never stops the run
        failed += 1
        print(f"FAILED {job['glb']}: {e}", flush=True)
    if (done + failed) % 50 == 0:
        print(f'progress: {done} rendered, {failed} failed', flush=True)
print(f'finished: {done} rendered, {failed} failed', flush=True)
