"""Private Auto Montage worker: analyze one rush, or plan and assemble one montage run.

Main validates the library root and owns its locks. Only fixed failure codes
cross the bridge; details go to the redacted log.
"""
import asyncio
import json
import logging
import os
import signal
import sys
from pathlib import Path

from bridge_runner import reserve_stdout_for_protocol, emit

logger = logging.getLogger('montage_runner')
ACTIONS = ('analyze', 'generate')
ERROR_CODES = frozenset({'invalid', 'duration', 'source_missing', 'invalid_edit', 'render_failed', 'engine_unavailable',
                         'music_invalid', 'cancelled'})


def failure_code(error):
    if isinstance(error, asyncio.CancelledError):
        return 'cancelled'
    code = getattr(error, 'editor_code', None)
    if code in ERROR_CODES:
        return code
    if type(error).__name__ in ('RenderingError', 'MediaProcessError', 'CalledProcessError'):
        return 'render_failed'
    if isinstance(error, ImportError):
        return 'engine_unavailable'
    return None


def checked_paths(config):
    library = Path(config['library']).resolve(strict=True)
    root = Path(config['root'])
    if root.is_symlink() or root.resolve(strict=True) != library / '_rushes':
        raise ValueError('Rush library is outside the library')
    run = None
    if config['action'] == 'generate':
        run = Path(config['run'])
        if run.is_symlink() or run.resolve(strict=True).parent != library:
            raise ValueError('Montage run is outside the library')
        run = run.resolve()
    return library / '_rushes', run


def main():
    reserve_stdout_for_protocol()
    action = None
    try:
        from clip_engine.logging_safety import install_safe_logging
        install_safe_logging()
        raw = sys.stdin.read(65537)
        if len(raw) > 65536:
            raise ValueError('Request too large')
        config = json.loads(raw)
        action = config.get('action')
        if action not in ACTIONS:
            raise ValueError('Invalid montage action')
        root, run = checked_paths(config)
        os.environ['LOCAL_MODE'] = 'true'
        from network_guard import install
        install()
        progress = lambda value: emit({'type': 'progress', **value})

        async def work():
            task = asyncio.current_task()
            if os.name != 'nt':
                asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, task.cancel)
            if action == 'analyze':
                from clip_engine.montage.analyze import analyze_rush
                return await analyze_rush(root, config.get('rush_id'), str(config.get('name') or ''), progress)
            from clip_engine.montage.assemble import generate
            return await generate(root, run, config.get('request'), config.get('music') or None, progress)
        result = asyncio.run(work())
        emit({'ok': True, 'result': result})
        return 0
    except (Exception, asyncio.CancelledError) as error:
        code = failure_code(error)
        try:
            from clip_engine.logging_safety import safe_log_text
            logger.error('Montage %s failed (%s): %s: %s', action if action in ACTIONS else 'request', code or 'unknown',
                         type(error).__name__, safe_log_text(str(error))[-300:])
        except Exception:
            pass
        emit({'ok': False, 'error': code})
        return 1


if __name__ == '__main__':
    sys.exit(main())
