"""Write src/shared/caption-style-presets.json from the engine's caption presets.

The editor shows each preset's values next to the user's overrides, so the UI
must use exactly the engine's numbers. engine/tests/test_caption_preset_sync.py
fails when this file is stale; regenerate with:

    PYTHONPATH=engine engine/.venv/bin/python scripts/export_caption_presets.py
"""
import json
import sys
from pathlib import Path

from clip_engine.config import CAPTION_OVERRIDE_FIELDS, get_available_presets, get_caption_preset


def preset_values(preset_id):
    style = get_caption_preset(preset_id)
    values = {}
    for key in CAPTION_OVERRIDE_FIELDS:
        if key == 'entrance':
            values[key] = 'pop' if style.entrance_pop else 'fade' if style.entrance_fade_ms else 'none'
        elif key == 'exit':
            values[key] = 'fade' if style.exit_fade_ms else 'none'
        elif key == 'x':
            values[key] = style.x_fraction
        else:
            values[key] = getattr(style, key)
    return values


def export():
    return {'presets': [{'id': p['id'], 'name': p['name'], 'description': p['description'], 'values': preset_values(p['id'])}
                        for p in get_available_presets()]}


if __name__ == '__main__':
    target = Path(__file__).resolve().parents[2] / 'src/shared/caption-style-presets.json'
    target.write_text(json.dumps(export(), indent=2, ensure_ascii=False) + '\n', encoding='utf8')
    sys.stdout.write(f'Wrote {target}\n')
