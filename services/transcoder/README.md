# Transcoder service (GitHub Actions)

This service transcodes a source media file into a web-friendly rendition and uploads it to
Telegram storage. It is designed to run as a GitHub Actions workflow (see
`.github/workflows/transcode.yml`), not as a long-running daemon.

## Trigger

- Manual: `workflow_dispatch` with `source_url`, `rendition`, `max_size_mb`.
- Automated: `repository_dispatch` from the OpenDrive API when a large video is uploaded.

## Requirements

- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_STORAGE_CHAT_ID` secrets.
- Source URL must be a short-lived, HTTPS delivery URL.

## Limits

- Public Telegram Bot API: ~20 MB per file.
- Self-hosted `--local` Bot API server required for larger files.
- Runner disk and 6-hour job limit apply.

## Next steps

- Add an OpenDrive API endpoint to register the resulting rendition.
- Player quality selector to choose between original and transcoded variants.
