FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py validation.py ./

ENV PYTHONUNBUFFERED=1

EXPOSE 8080

# Single worker: the in-process scheduler thread must exist exactly once.
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "1", "--threads", "4", "--timeout", "600", "main:app"]
