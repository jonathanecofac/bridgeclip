"""The editor's preset table (src/shared/caption-style-presets.json) matches the engine."""
import importlib.util
import json
from pathlib import Path

import pytest

from clip_engine.config import CAPTION_OVERRIDE_FIELDS, caption_style_for, get_caption_preset, validate_caption_overrides

ROOT = Path(__file__).resolve().parents[2]


def exporter():
    spec = importlib.util.spec_from_file_location('export_caption_presets', ROOT / 'scripts/export_caption_presets.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_editor_preset_table_is_current():
    assert json.loads((ROOT / 'src/shared/caption-style-presets.json').read_text(encoding='utf8')) == exporter().export(), \
        'Run scripts/export_caption_presets.py'


def test_every_preset_value_is_a_valid_override():
    for preset in exporter().export()['presets']:
        assert validate_caption_overrides(preset['values']) == preset['values'], preset['id']


def test_six_editor_templates_exist():
    ids = [p['id'] for p in exporter().export()['presets']]
    assert ids[:6] == ['viral_bold', 'hormozi', 'karaoke', 'minimal_clean', 'gaming', 'cinematic']


def test_overrides_apply_and_are_strict():
    style = caption_style_for('hormozi', {'font_name': 'Instrument Serif Italic', 'font_size': 70, 'max_words_per_line': 1,
                                          'entrance': 'fade', 'exit': 'fade', 'x': .3, 'line_box_color': '#101010', 'glow_color': None})
    assert (style.font_name, style.italic, style.font_size, style.max_words_per_line) == ('Instrument Serif Italic', True, 70, 1)
    assert (style.entrance_pop, style.entrance_fade_ms, style.exit_fade_ms, style.x_fraction) == (False, 200, 200, .3)
    assert style.line_box_color == '#101010' and style.glow_color is None
    assert get_caption_preset('hormozi').font_size == 100, 'presets are not mutated'
    for bad in [{'font_name': 'Comic Sans'}, {'font_size': 500}, {'primary_color': 'red'}, {'x': 1.5}, {'unknown': 1},
                {'uppercase': 1}, {'max_words_per_line': 2.5}, {'entrance': 'spin'}, ['font_size']]:
        with pytest.raises(ValueError):
            caption_style_for('pop', bad)
    assert len(CAPTION_OVERRIDE_FIELDS) == 23
