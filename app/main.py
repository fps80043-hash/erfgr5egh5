"""App factory (optional).

For now we keep the production app in `app_legacy.py` to avoid breaking changes.
New code should prefer importing `create_app()` from here.
"""

from app_legacy import app as _app


def create_app():
    return _app
