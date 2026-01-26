"""Main application package.

Render runs: `uvicorn app:app`.
Because we also have an `app/` package (this directory), Python resolves `import app`
*to this package*, not to `app.py`.

So we export the FastAPI instance here to keep the deployment command stable.
"""

from app_legacy import app as app  # noqa: F401

__all__ = ["app"]
