#!/usr/bin/env python3
"""DEXA Meeting Python backend.

Dependency-free HTTP backend for authentication, WebRTC signaling, chat,
reactions, participant state, and static frontend delivery.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import shutil
import threading
import time
import uuid
import webbrowser
from dataclasses import dataclass, field
from datetime import datetime, timezone
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

BASE_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = BASE_DIR / "public"
USERS_FILE = BASE_DIR / "data" / "users.json"
AVATAR_DIR = PUBLIC_DIR / "uploads" / "avatars"


def load_env_file(filename: Path) -> None:
    """Load KEY=VALUE pairs without overriding existing environment values."""
    if not filename.exists():
        return
    for raw_line in filename.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        if key:
            os.environ.setdefault(key, value)


load_env_file(BASE_DIR / ".env")

PORT = int(os.environ.get("PORT", "3000"))
APP_ENV = os.environ.get("APP_ENV", os.environ.get("NODE_ENV", "development")).lower()
IS_PRODUCTION = APP_ENV == "production"
JWT_SECRET = os.environ.get(
    "JWT_SECRET", "development-only-change-this-secret-before-deploying"
).encode("utf-8")
MAX_ROOM_SIZE = max(2, min(12, int(os.environ.get("MAX_ROOM_SIZE", "8"))))
MAX_BODY_BYTES = 100_000
MAX_PROFILE_BODY_BYTES = 2_500_000
MAX_AVATAR_BYTES = 1_500_000
MAX_SESSION_ACCOUNTS = 8
EMAIL_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{1,31}@dexa\.online$", re.I)
ROOM_PATTERN = re.compile(r"^[a-z0-9]{3}-[a-z0-9]{4}-[a-z0-9]{3}$", re.I)
ALLOWED_REACTIONS = {"👍", "👏", "❤️", "😂", "🎉", "✋"}
ALLOWED_SIGNAL_TYPES = {
    "webrtc-offer",
    "webrtc-answer",
    "webrtc-ice-candidate",
}

USERS_FILE.parent.mkdir(parents=True, exist_ok=True)
AVATAR_DIR.mkdir(parents=True, exist_ok=True)
if not USERS_FILE.exists():
    USERS_FILE.write_text("[]\n", encoding="utf-8")


@dataclass
class Participant:
    client_id: str
    user: dict[str, str]
    media: dict[str, bool]
    queue: list[dict[str, Any]] = field(default_factory=list)
    last_seen: float = field(default_factory=time.time)


@dataclass
class Room:
    participants: dict[str, Participant] = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)


rooms: dict[str, Room] = {}
rooms_lock = threading.RLock()
users_lock = threading.RLock()
rate_lock = threading.RLock()
rate_buckets: dict[str, dict[str, float | int]] = {}


def utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def base64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def base64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode((value + padding).encode("ascii"))


def public_user(user: dict[str, Any]) -> dict[str, str]:
    avatar = str(user.get("avatar") or "")
    return {
        "id": str(user["id"]),
        "name": str(user["name"]),
        "email": str(user["email"]),
        "avatar": avatar,
    }


def sign_session(account_ids: list[str], active_id: str) -> str:
    unique_ids: list[str] = []
    for account_id in account_ids:
        value = str(account_id)
        if value and value not in unique_ids:
            unique_ids.append(value)
    payload = {
        "v": 2,
        "accounts": unique_ids[:MAX_SESSION_ACCOUNTS],
        "active": str(active_id),
        "exp": int((time.time() + 7 * 24 * 60 * 60) * 1000),
    }
    encoded = base64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    signature = base64url_encode(hmac.new(JWT_SECRET, encoded.encode("ascii"), hashlib.sha256).digest())
    return f"{encoded}.{signature}"


def verify_session(token: str | None) -> dict[str, Any] | None:
    try:
        if not token:
            return None
        payload_text, supplied_signature = token.split(".", 1)
        expected = hmac.new(JWT_SECRET, payload_text.encode("ascii"), hashlib.sha256).digest()
        supplied = base64url_decode(supplied_signature)
        if not hmac.compare_digest(expected, supplied):
            return None
        payload = json.loads(base64url_decode(payload_text).decode("utf-8"))
        if int(payload.get("exp", 0)) < int(time.time() * 1000):
            return None

        # Upgrade older one-account cookies automatically.
        if isinstance(payload.get("accounts"), list):
            account_ids = [str(value) for value in payload["accounts"] if value]
            active_id = str(payload.get("active") or "")
        else:
            active_id = str(payload.get("id") or "")
            account_ids = [active_id] if active_id else []

        unique_ids: list[str] = []
        for account_id in account_ids:
            if account_id not in unique_ids:
                unique_ids.append(account_id)
        if not active_id or active_id not in unique_ids:
            active_id = unique_ids[-1] if unique_ids else ""
        if not active_id:
            return None
        return {"accounts": unique_ids[:MAX_SESSION_ACCOUNTS], "active": active_id}
    except (ValueError, KeyError, TypeError, json.JSONDecodeError, UnicodeDecodeError):
        return None


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    derived = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=16384, r=8, p=1, dklen=64)
    return f"{base64url_encode(salt)}:{base64url_encode(derived)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        salt_text, hash_text = stored.split(":", 1)
        salt = base64url_decode(salt_text)
        expected = base64url_decode(hash_text)
        actual = hashlib.scrypt(
            password.encode("utf-8"), salt=salt, n=16384, r=8, p=1, dklen=len(expected)
        )
        return hmac.compare_digest(expected, actual)
    except (ValueError, TypeError):
        return False


def read_users() -> list[dict[str, Any]]:
    with users_lock:
        try:
            data = json.loads(USERS_FILE.read_text(encoding="utf-8"))
            return data if isinstance(data, list) else []
        except (OSError, json.JSONDecodeError):
            return []


def write_users(users: list[dict[str, Any]]) -> None:
    with users_lock:
        temp_path = USERS_FILE.with_suffix(f".json.{os.getpid()}.{threading.get_ident()}.tmp")
        temp_path.write_text(json.dumps(users, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        try:
            os.chmod(temp_path, 0o600)
        except OSError:
            pass
        os.replace(temp_path, USERS_FILE)




def find_user_by_id(users: list[dict[str, Any]], user_id: str) -> dict[str, Any] | None:
    return next((item for item in users if str(item.get("id")) == str(user_id)), None)


def session_users(session: dict[str, Any] | None) -> tuple[list[dict[str, Any]], dict[str, Any] | None, list[str]]:
    if not session:
        return [], None, []
    users = read_users()
    valid_ids: list[str] = []
    accounts: list[dict[str, Any]] = []
    for account_id in session.get("accounts", []):
        user = find_user_by_id(users, str(account_id))
        if user and str(user.get("id")) not in valid_ids:
            valid_ids.append(str(user["id"]))
            accounts.append(user)
    active = find_user_by_id(accounts, str(session.get("active") or ""))
    if active is None and accounts:
        active = accounts[-1]
    return accounts, active, valid_ids


def add_account_to_session(session: dict[str, Any] | None, user_id: str) -> tuple[list[str], str]:
    ids = [str(value) for value in (session or {}).get("accounts", []) if value]
    user_id = str(user_id)
    ids = [value for value in ids if value != user_id]
    ids.append(user_id)
    return ids[-MAX_SESSION_ACCOUNTS:], user_id


def public_accounts(account_ids: list[str]) -> list[dict[str, str]]:
    users = read_users()
    result: list[dict[str, str]] = []
    for account_id in account_ids:
        user = find_user_by_id(users, account_id)
        if user:
            result.append(public_user(user))
    return result


def decode_avatar_data(value: Any) -> tuple[bytes, str]:
    text = str(value or "")
    match = re.fullmatch(r"data:image/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=\s]+)", text, re.I)
    if not match:
        raise BodyError("Choose a valid PNG, JPG, WEBP, or GIF profile picture.", HTTPStatus.BAD_REQUEST)
    try:
        raw = base64.b64decode(re.sub(r"\s+", "", match.group(2)), validate=True)
    except (ValueError, TypeError) as error:
        raise BodyError("The profile picture data is invalid.", HTTPStatus.BAD_REQUEST) from error
    if not raw or len(raw) > MAX_AVATAR_BYTES:
        raise BodyError("Profile picture must be smaller than 1.5 MB.", HTTPStatus.REQUEST_ENTITY_TOO_LARGE)

    kind = match.group(1).lower()
    if kind in {"jpeg", "jpg"} and raw.startswith(b"\xff\xd8\xff"):
        return raw, "jpg"
    if kind == "png" and raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return raw, "png"
    if kind == "gif" and raw[:6] in {b"GIF87a", b"GIF89a"}:
        return raw, "gif"
    if kind == "webp" and len(raw) >= 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return raw, "webp"
    raise BodyError("The uploaded file is not a supported image.", HTTPStatus.BAD_REQUEST)


def remove_avatar_file(avatar_url: str) -> None:
    filename = Path(str(avatar_url or "")).name
    if not filename:
        return
    path = (AVATAR_DIR / filename).resolve()
    try:
        path.relative_to(AVATAR_DIR.resolve())
    except ValueError:
        return
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


def normalize_email(value: Any) -> str:
    return str(value or "").strip().lower()


def normalize_name(value: Any) -> str:
    return " ".join(str(value or "").strip().split())[:60]


def safe_media(media: Any) -> dict[str, bool]:
    media = media if isinstance(media, dict) else {}
    return {
        "mic": media.get("mic") is not False,
        "camera": media.get("camera") is not False,
        "sharing": media.get("sharing") is True,
    }


def generate_room_id() -> str:
    alphabet = "abcdefghjkmnpqrstuvwxyz23456789"

    def part(length: int) -> str:
        return "".join(secrets.choice(alphabet) for _ in range(length))

    return f"{part(3)}-{part(4)}-{part(3)}"


def sanitize_room_id(value: str) -> str | None:
    room_id = str(value or "").strip().lower()
    return room_id if ROOM_PATTERN.fullmatch(room_id) else None


def queue_event(participant: Participant, event_type: str, data: Any) -> None:
    participant.queue.append(
        {"id": str(uuid.uuid4()), "type": event_type, "data": data, "sentAt": utc_iso()}
    )
    if len(participant.queue) > 500:
        del participant.queue[:-500]


def broadcast(room: Room, event_type: str, data: Any, except_client_id: str | None = None) -> None:
    for client_id, participant in room.participants.items():
        if client_id != except_client_id:
            queue_event(participant, event_type, data)


def remove_participant(room_id: str, client_id: str) -> None:
    with rooms_lock:
        room = rooms.get(room_id)
        if not room:
            return
        participant = room.participants.pop(client_id, None)
        if not participant:
            return
        broadcast(room, "user-left", {"clientId": client_id, "user": participant.user})
        if not room.participants:
            rooms.pop(room_id, None)


def rate_limit(ip: str, key: str, limit: int = 40, window_seconds: int = 15 * 60) -> bool:
    now = time.time()
    bucket_key = f"{ip}:{key}"
    with rate_lock:
        bucket = rate_buckets.get(bucket_key)
        if not bucket or float(bucket["reset_at"]) <= now:
            rate_buckets[bucket_key] = {"count": 1, "reset_at": now + window_seconds}
            return True
        bucket["count"] = int(bucket["count"]) + 1
        return int(bucket["count"]) <= limit


class DexaServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class DexaRequestHandler(BaseHTTPRequestHandler):
    server_version = "DEXA-Meeting-Python/1.0"

    def log_message(self, format_string: str, *args: Any) -> None:
        print(f"[{self.log_date_time_string()}] {self.client_address[0]} {format_string % args}")

    def do_GET(self) -> None:  # noqa: N802
        self.handle_request()

    def do_HEAD(self) -> None:  # noqa: N802
        self.handle_request()

    def do_POST(self) -> None:  # noqa: N802
        self.handle_request()

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_security_headers()
        self.end_headers()

    def handle_request(self) -> None:
        try:
            parsed = urlsplit(self.path)
            if parsed.path.startswith("/api/"):
                self.handle_api(parsed.path, parse_qs(parsed.query))
            elif self.command in {"GET", "HEAD"}:
                self.serve_static(parsed.path)
            else:
                self.send_json(HTTPStatus.METHOD_NOT_ALLOWED, {"error": "Method not allowed."})
        except BodyError as error:
            self.send_json(error.status, {"error": str(error)})
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as error:  # Keep server alive and avoid exposing details.
            print(f"Server error: {error!r}")
            try:
                self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "Server error."})
            except (BrokenPipeError, ConnectionResetError):
                return

    def send_security_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("Permissions-Policy", "camera=(self), microphone=(self), display-capture=(self)")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header(
            "Content-Security-Policy",
            "; ".join(
                [
                    "default-src 'self'",
                    "script-src 'self'",
                    "style-src 'self' 'unsafe-inline'",
                    "img-src 'self' data: blob:",
                    "media-src 'self' blob:",
                    "connect-src 'self'",
                    "worker-src 'self' blob:",
                    "object-src 'none'",
                    "frame-ancestors 'none'",
                    "base-uri 'self'",
                    "form-action 'self'",
                ]
            ),
        )

    def send_json(
        self,
        status: int | HTTPStatus,
        payload: Any,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        body = b"" if payload is None else json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(int(status))
        self.send_security_headers()
        if payload is not None:
            self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        for name, value in (extra_headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD" and body:
            self.wfile.write(body)

    def read_json_body(self, max_bytes: int = MAX_BODY_BYTES) -> dict[str, Any]:
        content_length_text = self.headers.get("Content-Length", "0")
        try:
            content_length = int(content_length_text)
        except ValueError as error:
            raise BodyError("Invalid Content-Length.", HTTPStatus.BAD_REQUEST) from error
        if content_length < 0 or content_length > max_bytes:
            raise BodyError("Request is too large.", HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
        if content_length == 0:
            return {}
        raw = self.rfile.read(content_length)
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise BodyError("Invalid JSON body.", HTTPStatus.BAD_REQUEST) from error
        if not isinstance(value, dict):
            raise BodyError("JSON body must be an object.", HTTPStatus.BAD_REQUEST)
        return value

    def request_ip(self) -> str:
        forwarded = self.headers.get("X-Forwarded-For", "")
        return forwarded.split(",", 1)[0].strip() or self.client_address[0]

    def request_session(self) -> dict[str, Any] | None:
        cookie_header = self.headers.get("Cookie", "")
        cookie = SimpleCookie()
        try:
            cookie.load(cookie_header)
            token = cookie.get("dexa_token")
            return verify_session(token.value if token else None)
        except Exception:
            return None

    def request_user(self) -> dict[str, str] | None:
        _accounts, active, _ids = session_users(self.request_session())
        return public_user(active) if active else None

    def authenticate(self) -> dict[str, str] | None:
        user = self.request_user()
        if not user:
            self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "Please log in first."})
            return None
        return user

    @staticmethod
    def auth_cookie(token: str) -> str:
        secure = "; Secure" if IS_PRODUCTION else ""
        return (
            f"dexa_token={token}; Path=/; HttpOnly; SameSite=Lax; "
            f"Max-Age=604800{secure}"
        )

    @staticmethod
    def clear_auth_cookie() -> str:
        secure = "; Secure" if IS_PRODUCTION else ""
        return f"dexa_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{secure}"

    def handle_api(self, path: str, query: dict[str, list[str]]) -> None:
        method = self.command

        if method == "POST" and path == "/api/register":
            if not rate_limit(self.request_ip(), "register"):
                self.send_json(HTTPStatus.TOO_MANY_REQUESTS, {"error": "Too many attempts. Please wait and try again."})
                return
            body = self.read_json_body()
            name = normalize_name(body.get("name"))
            email = normalize_email(body.get("email"))
            password = str(body.get("password") or "")
            if len(name) < 2:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Enter your full name."})
                return
            if not EMAIL_PATTERN.fullmatch(email):
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Use a valid @dexa.online email address."})
                return
            if not 8 <= len(password) <= 72:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Password must be 8 to 72 characters."})
                return
            with users_lock:
                users = read_users()
                if any(item.get("email") == email for item in users):
                    self.send_json(HTTPStatus.CONFLICT, {"error": "This account already exists."})
                    return
                user = {
                    "id": str(uuid.uuid4()),
                    "name": name,
                    "email": email,
                    "passwordHash": hash_password(password),
                    "avatar": "",
                    "createdAt": utc_iso(),
                }
                users.append(user)
                write_users(users)
            account_ids, active_id = add_account_to_session(self.request_session(), str(user["id"]))
            self.send_json(
                HTTPStatus.CREATED,
                {"user": public_user(user), "accounts": public_accounts(account_ids)},
                {"Set-Cookie": self.auth_cookie(sign_session(account_ids, active_id))},
            )
            return

        if method == "POST" and path == "/api/login":
            if not rate_limit(self.request_ip(), "login"):
                self.send_json(HTTPStatus.TOO_MANY_REQUESTS, {"error": "Too many attempts. Please wait and try again."})
                return
            body = self.read_json_body()
            email = normalize_email(body.get("email"))
            password = str(body.get("password") or "")
            if not EMAIL_PATTERN.fullmatch(email):
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Use your @dexa.online email address."})
                return
            user = next((item for item in read_users() if item.get("email") == email), None)
            if not user or not verify_password(password, str(user.get("passwordHash") or "")):
                self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "Incorrect email or password."})
                return
            account_ids, active_id = add_account_to_session(self.request_session(), str(user["id"]))
            self.send_json(
                HTTPStatus.OK,
                {"user": public_user(user), "accounts": public_accounts(account_ids)},
                {"Set-Cookie": self.auth_cookie(sign_session(account_ids, active_id))},
            )
            return

        if method == "POST" and path == "/api/logout":
            session = self.request_session()
            accounts, active, account_ids = session_users(session)
            if not active:
                self.send_json(HTTPStatus.OK, {"user": None, "accounts": []}, {"Set-Cookie": self.clear_auth_cookie()})
                return
            remaining_ids = [value for value in account_ids if value != str(active["id"])]
            if not remaining_ids:
                self.send_json(HTTPStatus.OK, {"user": None, "accounts": []}, {"Set-Cookie": self.clear_auth_cookie()})
                return
            next_active_id = remaining_ids[-1]
            next_active = find_user_by_id(accounts, next_active_id)
            self.send_json(
                HTTPStatus.OK,
                {"user": public_user(next_active), "accounts": public_accounts(remaining_ids)},
                {"Set-Cookie": self.auth_cookie(sign_session(remaining_ids, next_active_id))},
            )
            return

        if method == "POST" and path == "/api/logout-all":
            self.send_json(HTTPStatus.OK, {"user": None, "accounts": []}, {"Set-Cookie": self.clear_auth_cookie()})
            return

        if method == "GET" and path == "/api/me":
            session = self.request_session()
            accounts, active, account_ids = session_users(session)
            if not active:
                self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "Please log in first."})
                return
            headers: dict[str, str] = {}
            if account_ids != list((session or {}).get("accounts", [])) or str((session or {}).get("active")) != str(active["id"]):
                headers["Set-Cookie"] = self.auth_cookie(sign_session(account_ids, str(active["id"])))
            self.send_json(
                HTTPStatus.OK,
                {"user": public_user(active), "accounts": [public_user(item) for item in accounts]},
                headers,
            )
            return

        if method == "POST" and path == "/api/accounts/switch":
            body = self.read_json_body()
            requested_id = str(body.get("userId") or "")
            accounts, _active, account_ids = session_users(self.request_session())
            selected = find_user_by_id(accounts, requested_id)
            if not selected or requested_id not in account_ids:
                self.send_json(HTTPStatus.FORBIDDEN, {"error": "That account is not signed in on this device."})
                return
            self.send_json(
                HTTPStatus.OK,
                {"user": public_user(selected), "accounts": [public_user(item) for item in accounts]},
                {"Set-Cookie": self.auth_cookie(sign_session(account_ids, requested_id))},
            )
            return

        if method == "POST" and path == "/api/profile":
            session = self.request_session()
            accounts, active, account_ids = session_users(session)
            if not active:
                self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "Please log in first."})
                return
            body = self.read_json_body(MAX_PROFILE_BODY_BYTES)
            name = normalize_name(body.get("name"))
            if len(name) < 2:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Enter your full name."})
                return

            new_avatar = str(active.get("avatar") or "")
            old_avatar = new_avatar
            avatar_data = body.get("avatarData")
            remove_avatar = body.get("removeAvatar") is True
            if remove_avatar:
                new_avatar = ""
            elif avatar_data:
                raw, extension = decode_avatar_data(avatar_data)
                filename = f"{active['id']}-{uuid.uuid4().hex}.{extension}"
                target = AVATAR_DIR / filename
                target.write_bytes(raw)
                new_avatar = f"/uploads/avatars/{filename}"

            with users_lock:
                users = read_users()
                stored = find_user_by_id(users, str(active["id"]))
                if not stored:
                    self.send_json(HTTPStatus.NOT_FOUND, {"error": "Account no longer exists."})
                    return
                stored["name"] = name
                stored["avatar"] = new_avatar
                stored["updatedAt"] = utc_iso()
                write_users(users)
                updated = public_user(stored)

            if old_avatar and old_avatar != new_avatar:
                remove_avatar_file(old_avatar)
            refreshed_accounts = public_accounts(account_ids)
            self.send_json(
                HTTPStatus.OK,
                {"user": updated, "accounts": refreshed_accounts},
                {"Set-Cookie": self.auth_cookie(sign_session(account_ids, str(active["id"])))},
            )
            return

        if method == "GET" and path == "/api/config":
            user = self.authenticate()
            if not user:
                return
            ice_servers: list[dict[str, Any]] = [
                {"urls": ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]}
            ]
            turn_url = os.environ.get("TURN_URL", "").strip()
            turn_username = os.environ.get("TURN_USERNAME", "").strip()
            turn_credential = os.environ.get("TURN_CREDENTIAL", "").strip()
            if turn_url and turn_username and turn_credential:
                ice_servers.append(
                    {
                        "urls": [value.strip() for value in turn_url.split(",") if value.strip()],
                        "username": turn_username,
                        "credential": turn_credential,
                    }
                )
            self.send_json(HTTPStatus.OK, {"iceServers": ice_servers, "maxRoomSize": MAX_ROOM_SIZE})
            return

        if method == "POST" and path == "/api/meetings":
            user = self.authenticate()
            if user:
                self.send_json(HTTPStatus.CREATED, {"roomId": generate_room_id()})
            return

        match = re.fullmatch(r"/api/rooms/([^/]+)/(join|events|signal|broadcast|leave)", path)
        if not match:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "API route not found."})
            return

        user = self.authenticate()
        if not user:
            return
        room_id = sanitize_room_id(unquote(match.group(1)))
        action = match.group(2)
        if not room_id:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Invalid meeting code."})
            return

        if method == "POST" and action == "join":
            body = self.read_json_body()
            with rooms_lock:
                room = rooms.setdefault(room_id, Room())
                if len(room.participants) >= MAX_ROOM_SIZE:
                    self.send_json(HTTPStatus.CONFLICT, {"error": "This meeting is full."})
                    return
                client_id = str(uuid.uuid4())
                peers = [
                    {"clientId": peer_id, "user": participant.user, "media": participant.media}
                    for peer_id, participant in room.participants.items()
                ]
                participant = Participant(
                    client_id=client_id,
                    user=user,
                    media=safe_media(body.get("media")),
                )
                room.participants[client_id] = participant
                broadcast(
                    room,
                    "user-joined",
                    {"clientId": client_id, "user": user, "media": participant.media},
                    client_id,
                )
            self.send_json(HTTPStatus.OK, {"ok": True, "clientId": client_id, "peers": peers})
            return

        body = {} if method == "GET" else self.read_json_body()
        client_id = (
            (query.get("clientId") or [""])[0]
            if method == "GET"
            else str(body.get("clientId") or "")
        )

        # Keep an events request open briefly. This turns the old fixed-interval
        # polling into long polling, so chat/signaling events are delivered as
        # soon as they are queued while remaining dependency-free.
        if method == "GET" and action == "events":
            deadline = time.time() + 20.0
            while True:
                with rooms_lock:
                    room = rooms.get(room_id)
                    participant = room.participants.get(client_id) if room else None
                    if not room or not participant or participant.user.get("id") != user.get("id"):
                        self.send_json(HTTPStatus.NOT_FOUND, {"error": "Meeting session not found."})
                        return
                    participant.last_seen = time.time()
                    if participant.queue:
                        events = participant.queue[:100]
                        del participant.queue[:100]
                        participant_count = len(room.participants)
                        self.send_json(HTTPStatus.OK, {"events": events, "participants": participant_count})
                        return
                    participant_count = len(room.participants)
                if time.time() >= deadline:
                    self.send_json(HTTPStatus.OK, {"events": [], "participants": participant_count})
                    return
                time.sleep(0.05)

        with rooms_lock:
            room = rooms.get(room_id)
            participant = room.participants.get(client_id) if room else None
            if not room or not participant or participant.user.get("id") != user.get("id"):
                self.send_json(HTTPStatus.NOT_FOUND, {"error": "Meeting session not found."})
                return
            participant.last_seen = time.time()

            if method == "POST" and action == "signal":
                target = room.participants.get(str(body.get("target") or ""))
                signal_type = str(body.get("type") or "")
                if not target or signal_type not in ALLOWED_SIGNAL_TYPES:
                    self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Invalid signal."})
                    return
                queue_event(
                    target,
                    signal_type,
                    {"from": client_id, "payload": body.get("payload"), "user": user},
                )
                self.send_json(HTTPStatus.ACCEPTED, {"ok": True})
                return

            if method == "POST" and action == "broadcast":
                event = str(body.get("event") or "")
                data = body.get("data") if isinstance(body.get("data"), dict) else {}
                if event == "chat-message":
                    text = str(data.get("text") or "").strip()[:1000]
                    if not text:
                        self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Message is empty."})
                        return
                    message = {
                        "id": str(uuid.uuid4()),
                        "user": user,
                        "text": text,
                        "sentAt": utc_iso(),
                    }
                    # Other participants receive the message from their live
                    # event stream. The sender receives the same canonical
                    # message in this request's response for instant display.
                    broadcast(room, "chat-message", message, client_id)
                    self.send_json(HTTPStatus.ACCEPTED, {"ok": True, "message": message})
                    return
                elif event == "reaction":
                    emoji = str(data.get("emoji") or "")
                    if emoji not in ALLOWED_REACTIONS:
                        self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Invalid reaction."})
                        return
                    broadcast(room, "reaction", {"clientId": client_id, "user": user, "emoji": emoji})
                elif event == "media-state":
                    participant.media = safe_media(data)
                    broadcast(
                        room,
                        "media-state",
                        {"clientId": client_id, "media": participant.media},
                        client_id,
                    )
                elif event == "profile-update":
                    participant.user = user
                    broadcast(
                        room,
                        "profile-update",
                        {"clientId": client_id, "user": user},
                        client_id,
                    )
                else:
                    self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Invalid broadcast event."})
                    return
                self.send_json(HTTPStatus.ACCEPTED, {"ok": True})
                return

            if method == "POST" and action == "leave":
                # Inline removal because the room lock is already held (RLock also makes helper safe).
                remove_participant(room_id, client_id)
                self.send_json(HTTPStatus.NO_CONTENT, None)
                return

        self.send_json(HTTPStatus.METHOD_NOT_ALLOWED, {"error": "Method not allowed."})

    def serve_static(self, request_path: str) -> None:
        requested = unquote(request_path)
        if requested == "/":
            requested = "/index.html"
        relative = requested.lstrip("/")
        candidate = (PUBLIC_DIR / relative).resolve()
        public_root = PUBLIC_DIR.resolve()
        try:
            candidate.relative_to(public_root)
        except ValueError:
            self.send_json(HTTPStatus.FORBIDDEN, {"error": "Forbidden."})
            return
        if not candidate.exists() or candidate.is_dir():
            candidate = PUBLIC_DIR / "index.html"
        mime_type, _ = mimetypes.guess_type(candidate.name)
        mime_type = mime_type or "application/octet-stream"
        if candidate.suffix.lower() in {".html", ".css", ".js", ".json", ".svg"}:
            mime_type += "; charset=utf-8"
        stat = candidate.stat()
        self.send_response(HTTPStatus.OK)
        self.send_security_headers()
        self.send_header("Content-Type", mime_type)
        self.send_header("Content-Length", str(stat.st_size))
        cache_header = (
            "public, max-age=3600"
            if IS_PRODUCTION and candidate.suffix.lower() != ".html"
            else "no-cache"
        )
        self.send_header("Cache-Control", cache_header)
        self.end_headers()
        if self.command == "HEAD":
            return
        with candidate.open("rb") as source:
            shutil.copyfileobj(source, self.wfile)


class BodyError(Exception):
    def __init__(self, message: str, status: int | HTTPStatus) -> None:
        super().__init__(message)
        self.status = int(status)


def cleanup_loop() -> None:
    while True:
        time.sleep(15)
        cutoff = time.time() - 45
        with rooms_lock:
            stale = [
                (room_id, client_id)
                for room_id, room in rooms.items()
                for client_id, participant in room.participants.items()
                if participant.last_seen < cutoff
            ]
            for room_id, client_id in stale:
                remove_participant(room_id, client_id)
        now = time.time()
        with rate_lock:
            expired = [key for key, bucket in rate_buckets.items() if float(bucket["reset_at"]) < now]
            for key in expired:
                rate_buckets.pop(key, None)


def main() -> None:
    cleanup_thread = threading.Thread(target=cleanup_loop, name="dexa-cleanup", daemon=True)
    cleanup_thread.start()

    server = DexaServer(("0.0.0.0", PORT), DexaRequestHandler)
    print(f"DEXA Meeting Python backend running on http://localhost:{PORT}")
    print("No pip install is required. Press Ctrl+C to stop.")
    if JWT_SECRET.startswith(b"development-only"):
        print("WARNING: Set JWT_SECRET in .env before deploying online.")

    if os.environ.get("AUTO_OPEN_BROWSER", "").lower() in {"1", "true", "yes", "on"}:
        threading.Timer(0.8, lambda: webbrowser.open(f"http://localhost:{PORT}")).start()

    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        print("\nStopping DEXA Meeting...")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
