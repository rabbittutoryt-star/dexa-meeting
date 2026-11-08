FROM python:3.12-slim
WORKDIR /app
COPY . .
ENV APP_ENV=production PORT=3000 PYTHONUNBUFFERED=1
EXPOSE 3000
CMD ["python", "server.py"]
