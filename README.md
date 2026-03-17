Insta Unfollower
===================
An Instagram script, allowing you to automatically unfollow accounts you are following but that doesn't follow you back. Without using the Instagram API.

## Installation
[UV](https://docs.astral.sh/uv/): `uv sync`
Copy `.env.example` to `.env` and set `INSTA_USERNAME` and `INSTA_PASSWORD`.

## Run
```bash
uv run python insta-unfollower.py
```

## Roadmap
- Username whitelist.
- Better flow for calculating time between requests to avoid ban.