FROM python:3.11-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# System deps for building wheels (psycopg/bcrypt/etc.)
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential \
      libpq-dev \
      curl \
      rustc \
      cargo \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/requirements.txt
RUN pip install --upgrade pip \
 && pip install -r /app/requirements.txt

COPY . /app

# /data is where Railway persistent volume is mounted.
# Add a Volume in Railway Dashboard → your service → Volumes → mount at /data
RUN mkdir -p /data
ENV DB_PATH=/data/data.db

# Railway/Render set PORT env var; default fallback is 8000
# Using python run.py which handles PORT parsing internally
CMD uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}

