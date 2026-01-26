# Refactor Notes

This repo previously had a very large `app.py` (single-file FastAPI app).
To keep deployment stable (Render starts `uvicorn app:app`) while making the codebase maintainable:

- The original implementation is now in `app_legacy.py` (unchanged logic).
- `app.py` is a tiny entrypoint that re-exports `app` from `app_legacy.py`.
- New code can gradually move into `app/` (`app/main.py`, `app/core/*`, etc.)

Next safe steps:
- Move groups of routes from `app_legacy.py` into dedicated modules under `app/routers/`
- Introduce a DB layer under `app/db/` with transactions helpers
- Standardize API errors and logging
