"""Smart reframing for the editor: turn a local face analysis into editable layouts.

`auto` lets the analyzer choose each shot's layout (one speaker: follow the
face; two people: split; screen with webcam: split; screen only: fit).
`face` keeps the speaker full frame and follows the face on every shot.
Both use the free local face detector (no vision model, no credits).

Face-following becomes ordinary editor layouts: a full-frame crop per focus
keyframe whose eased movement ends on that keyframe. The user can then
adjust, delete or move any of them like hand-made layouts.
"""
from clip_engine.services.layout_analyzer import LayoutType
from clip_engine.services.layout_renderer import PERSON_FACE_Y

MODES = ("auto", "face")
MAX_SCENES = 60
MIN_MOVE_MS = 100
MAX_MOVE_MS = 5000
# Keyframes closer than this (fraction of the source) are not worth a movement.
MIN_MOVE = .004


def _clamp(value, lo, hi):
    return max(lo, min(hi, value))


def follow_crop(cx, cy, src_w, src_h, aspect, bounds=None):
    """Normalized [x, y, w, h] crop of the output aspect around a face center, like the export's fill crop."""
    left, top, right, bottom = (0.0, 0.0, 1.0, 1.0) if bounds is None else (
        bounds.x, bounds.y, bounds.x + bounds.w, bounds.y + bounds.h)
    width, height = (right - left) * src_w, (bottom - top) * src_h
    if width / height > aspect:
        crop_h, crop_w = height, height * aspect
    else:
        crop_w, crop_h = width, width / aspect
    x = _clamp(cx * src_w - crop_w / 2, left * src_w, right * src_w - crop_w)
    y = _clamp(cy * src_h - crop_h * PERSON_FACE_Y, top * src_h, bottom * src_h - crop_h)
    return [round(x / src_w, 5), round(y / src_h, 5), round(crop_w / src_w, 5), round(crop_h / src_h, 5)]


def _moved(a, b):
    return max(abs(p - q) for p, q in zip(a, b))


def _thin(scenes):
    """Drop the smallest face-following moves until the layouts fit the editor's limit."""
    while len(scenes) > MAX_SCENES:
        moves = [i for i, s in enumerate(scenes) if i > 0 and s.get("transition_ms")]
        if not moves:
            del scenes[MAX_SCENES:]
            break
        i = min(moves, key=lambda k: _moved(scenes[k]["crops"][0], scenes[k - 1]["crops"][0]))
        removed = scenes.pop(i)
        if i < len(scenes) and scenes[i].get("transition_ms") and scenes[i]["layout"] == removed["layout"]:
            # The next move now starts where the removed one did, so the path stays continuous.
            end = scenes[i]["at_ms"] + scenes[i]["transition_ms"]
            start = max(removed["at_ms"], end - MAX_MOVE_MS)
            scenes[i]["at_ms"], scenes[i]["transition_ms"] = start, end - start
    return scenes


def reframe_scenes(plan, start_ms, end_ms, src_w, src_h, aspect):
    """Editor layouts (source time) for a clip spanning [start_ms, end_ms) from an analyzer plan."""
    from clip_engine.services.manual_editor import _shot_scene
    scenes = []

    def add(at, layout, crops, transition=0):
        at = round(at)
        if scenes and at <= scenes[-1]["at_ms"]:
            return
        if scenes and not transition and scenes[-1]["layout"] == layout and scenes[-1]["crops"] == crops:
            return
        scene = {"at_ms": at, "layout": layout, "crops": crops}
        if transition:
            scene["transition_ms"] = int(transition)
        scenes.append(scene)

    for shot in plan.shots:
        at, shot_end = start_ms + shot.start_ms, min(end_ms, start_ms + shot.end_ms)
        if at >= end_ms:
            break
        if shot.layout == LayoutType.TALKING_HEAD:
            path = shot.focus_path or [(0, .5, .5)]
            crop = follow_crop(path[0][1], path[0][2], src_w, src_h, aspect, shot.crop_bounds)
            add(at, "fill", [crop])
            previous_t, previous = at, crop
            for t, cx, cy in path[1:]:
                t = start_ms + shot.start_ms + t
                if t >= shot_end:
                    break
                crop = follow_crop(cx, cy, src_w, src_h, aspect, shot.crop_bounds)
                if _moved(crop, previous) < MIN_MOVE:
                    previous_t = t  # A hold: the next move starts after it.
                    continue
                if t - previous_t < MIN_MOVE_MS:
                    continue
                move_start = max(previous_t, t - MAX_MOVE_MS)
                if scenes and round(move_start) <= scenes[-1]["at_ms"]:
                    move_start = scenes[-1]["at_ms"] + 1
                if t - move_start < MIN_MOVE_MS:
                    continue
                add(move_start, "fill", [crop], round(t - move_start))
                previous_t, previous = t, crop
        else:
            layout, crops = _shot_scene(shot.summary() | {"layout": shot.layout}, src_w, src_h, aspect, None)
            add(at, layout, [[round(n, 5) for n in c] for c in crops])
    if not scenes:
        scenes = [{"at_ms": 0, "layout": "fill", "crops": [follow_crop(.5, .5, src_w, src_h, aspect)]}]
    scenes[0]["at_ms"] = 0
    scenes[0].pop("transition_ms", None)
    return _thin(scenes)
