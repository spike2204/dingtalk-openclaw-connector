"""
DingTalk platform adapter for Hermes Agent integration.

Inherits from Hermes's BasePlatformAdapter and implements an independent
DingTalk Stream connection using the dingtalk-stream Python SDK.
Does NOT depend on Hermes's built-in DingTalkAdapter.

Supports:
- Text message reception and reply (Phase 1)
- Image/audio/video/file/rich-text (Phase 2)
- AI Card streaming responses (Phase 2)
- Emoji reactions: 🤔Thinking → 🥳Done (Phase 2)
- Message deduplication, group mention gating (Phase 3)
"""

import asyncio
import json
import logging
import os
import re
import traceback
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set

try:
    import dingtalk_stream
    from dingtalk_stream import ChatbotMessage
    from dingtalk_stream.frames import CallbackMessage, AckMessage

    DINGTALK_STREAM_AVAILABLE = True
except ImportError:
    DINGTALK_STREAM_AVAILABLE = False
    dingtalk_stream = None
    ChatbotMessage = None
    CallbackMessage = None
    AckMessage = type(
        "AckMessage",
        (),
        {"STATUS_OK": 200, "STATUS_SYSTEM_EXCEPTION": 500},
    )

try:
    import httpx

    HTTPX_AVAILABLE = True
except ImportError:
    HTTPX_AVAILABLE = False
    httpx = None

# AI Card SDK (optional — fallback to webhook markdown when absent)
try:
    from alibabacloud_dingtalk.card_1_0 import (
        client as dingtalk_card_client,
        models as dingtalk_card_models,
    )
    from alibabacloud_dingtalk.robot_1_0 import (
        client as dingtalk_robot_client,
        models as dingtalk_robot_models,
    )
    from alibabacloud_tea_openapi import models as open_api_models
    from alibabacloud_tea_util import models as tea_util_models

    CARD_SDK_AVAILABLE = True
except ImportError:
    CARD_SDK_AVAILABLE = False
    dingtalk_card_client = None
    dingtalk_card_models = None
    dingtalk_robot_client = None
    dingtalk_robot_models = None
    open_api_models = None
    tea_util_models = None

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    SendResult,
)

logger = logging.getLogger(__name__)

MAX_MESSAGE_LENGTH = 20000
RECONNECT_BACKOFF = [2, 5, 10, 30, 60]
_SESSION_WEBHOOKS_MAX = 500
_DINGTALK_WEBHOOK_RE = re.compile(r"^https://(?:api|oapi)\.dingtalk\.com/")
_DEDUP_MAX_SIZE = 1000
_DEDUP_TTL_SECONDS = 300

# DingTalk AI Card template ID — shared across all DingTalk connectors.
# This is a platform-level template, no need for per-bot configuration.
AI_CARD_TEMPLATE_ID = "02fcf2f4-5e02-4a85-b672-46d1f715543e.schema"

# DingTalk message type → runtime content type
DINGTALK_TYPE_MAPPING = {
    "picture": "image",
    "voice": "audio",
}


class _MessageDeduplicator:
    """Simple LRU-style message deduplicator with TTL."""

    def __init__(self, max_size: int = _DEDUP_MAX_SIZE, ttl_seconds: int = _DEDUP_TTL_SECONDS):
        self._seen: Dict[str, float] = {}
        self._max_size = max_size
        self._ttl = ttl_seconds

    def is_duplicate(self, message_id: str) -> bool:
        now = datetime.now(tz=timezone.utc).timestamp()
        self._evict(now)
        if message_id in self._seen:
            return True
        self._seen[message_id] = now
        return False

    def _evict(self, now: float) -> None:
        if len(self._seen) < self._max_size:
            return
        cutoff = now - self._ttl
        expired = [k for k, ts in self._seen.items() if ts < cutoff]
        for key in expired:
            del self._seen[key]

    def clear(self) -> None:
        self._seen.clear()


class ConnectorDingTalkAdapter(BasePlatformAdapter):
    """DingTalk adapter for Connector → Hermes integration.

    Uses dingtalk-stream SDK to maintain a WebSocket connection.
    Incoming messages are parsed into MessageEvent and routed to
    Hermes's GatewayRunner via ``handle_message()``.
    Replies are sent via session webhook (markdown) or AI Card.
    """

    MAX_MESSAGE_LENGTH = MAX_MESSAGE_LENGTH

    @property
    def SUPPORTS_MESSAGE_EDITING(self) -> bool:
        return bool(self._card_sdk)

    @property
    def REQUIRES_EDIT_FINALIZE(self) -> bool:
        return bool(self._card_sdk)

    def __init__(self, config: PlatformConfig, account_id: str = "default"):
        super().__init__(config, Platform.DINGTALK)
        self._account_id = account_id

        extra = config.extra or {}
        self._client_id: str = extra.get("client_id", "")
        self._client_secret: str = extra.get("client_secret", "")

        # Group-chat gating
        self._require_mention: bool = bool(extra.get("require_mention", False))
        self._mention_patterns: List[re.Pattern] = self._compile_mention_patterns(extra)
        self._allowed_users: Set[str] = self._load_allowed_users(extra)
        self._free_response_chats: Set[str] = self._load_free_response_chats(extra)

        # Stream client
        self._stream_client: Any = None
        self._stream_task: Optional[asyncio.Task] = None
        self._http_client: Optional[Any] = None

        # AI Card SDK
        self._card_sdk: Optional[Any] = None
        self._robot_sdk: Optional[Any] = None
        self._robot_code: str = extra.get("robot_code", "") or self._client_id
        self._card_template_id: str = AI_CARD_TEMPLATE_ID

        # Deduplication
        self._dedup = _MessageDeduplicator()

        # Session webhook cache: chat_id -> (webhook_url, expired_time_ms)
        self._session_webhooks: Dict[str, tuple[str, int]] = {}

        # Inbound message context: chat_id -> last ChatbotMessage
        self._message_contexts: Dict[str, Any] = {}

        # Streaming cards tracking: chat_id -> {out_track_id -> last_content}
        self._streaming_cards: Dict[str, Dict[str, str]] = {}

        # Done emoji dedup: chat_ids where we already fired 🥳Done
        self._done_emoji_fired: Set[str] = set()

        # Fire-and-forget background tasks
        self._bg_tasks: Set[asyncio.Task] = set()

    # ── Connection lifecycle ──────────────────────────────────────────

    async def connect(self) -> bool:
        """Connect to DingTalk via Stream Mode."""
        if not DINGTALK_STREAM_AVAILABLE:
            logger.warning(
                "[Connector:%s] dingtalk-stream not installed. "
                "Run: pip install 'dingtalk-stream>=0.20'",
                self._account_id,
            )
            return False

        if not HTTPX_AVAILABLE:
            logger.warning(
                "[Connector:%s] httpx not installed. Run: pip install httpx",
                self._account_id,
            )
            return False

        if not self._client_id or not self._client_secret:
            logger.warning(
                "[Connector:%s] client_id and client_secret are required",
                self._account_id,
            )
            return False

        try:
            self._http_client = httpx.AsyncClient(timeout=30.0)

            credential = dingtalk_stream.Credential(self._client_id, self._client_secret)
            self._stream_client = dingtalk_stream.DingTalkStreamClient(credential)

            # Initialize AI Card SDK — always enabled (template ID is hardcoded)
            if CARD_SDK_AVAILABLE:
                sdk_config = open_api_models.Config()
                sdk_config.protocol = "https"
                sdk_config.region_id = "central"
                self._card_sdk = dingtalk_card_client.Client(sdk_config)
                self._robot_sdk = dingtalk_robot_client.Client(sdk_config)
                logger.info(
                    "[Connector:%s] Card SDK initialized (template: %s)",
                    self._account_id,
                    self._card_template_id,
                )

            # Register message handler
            loop = asyncio.get_running_loop()
            handler = _IncomingHandler(self, loop)
            self._stream_client.register_callback_handler(
                dingtalk_stream.ChatbotMessage.TOPIC, handler
            )

            self._stream_task = asyncio.create_task(self._run_stream())
            self._mark_connected()
            logger.info(
                "[Connector:%s] Connected to DingTalk via Stream Mode",
                self._account_id,
            )
            return True

        except Exception as exc:
            logger.error(
                "[Connector:%s] Failed to connect: %s", self._account_id, exc
            )
            return False

    async def _run_stream(self) -> None:
        """Run the stream client with auto-reconnection."""
        backoff_idx = 0
        while self._running:
            try:
                logger.debug("[Connector:%s] Starting stream client...", self._account_id)
                await self._stream_client.start()
            except asyncio.CancelledError:
                return
            except Exception as exc:
                if not self._running:
                    return
                logger.warning("[Connector:%s] Stream error: %s", self._account_id, exc)

            if not self._running:
                return

            delay = RECONNECT_BACKOFF[min(backoff_idx, len(RECONNECT_BACKOFF) - 1)]
            logger.info("[Connector:%s] Reconnecting in %ds...", self._account_id, delay)
            await asyncio.sleep(delay)
            backoff_idx += 1

    async def disconnect(self) -> None:
        """Disconnect from DingTalk."""
        self._running = False
        self._mark_disconnected()

        # Close websocket
        websocket = getattr(self._stream_client, "websocket", None) if self._stream_client else None
        if websocket is not None:
            try:
                await websocket.close()
            except Exception:
                pass

        if self._stream_task:
            if hasattr(self._stream_client, "close"):
                try:
                    await asyncio.to_thread(self._stream_client.close)
                except Exception:
                    pass
            self._stream_task.cancel()
            try:
                await asyncio.wait_for(self._stream_task, timeout=5.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass
            self._stream_task = None

        # Cancel background tasks
        if self._bg_tasks:
            for task in list(self._bg_tasks):
                task.cancel()
            await asyncio.gather(*self._bg_tasks, return_exceptions=True)
            self._bg_tasks.clear()

        if self._http_client:
            await self._http_client.aclose()
            self._http_client = None

        self._stream_client = None
        self._session_webhooks.clear()
        self._message_contexts.clear()
        self._streaming_cards.clear()
        self._done_emoji_fired.clear()
        self._dedup.clear()
        logger.info("[Connector:%s] Disconnected", self._account_id)

    # ── Group gating ─────────────────────────────────────────────────

    @staticmethod
    def _compile_mention_patterns(extra: Dict[str, Any]) -> List[re.Pattern]:
        patterns = extra.get("mention_patterns")
        if not patterns:
            return []
        if isinstance(patterns, str):
            patterns = [patterns]
        compiled = []
        for pattern in patterns:
            if not isinstance(pattern, str) or not pattern.strip():
                continue
            try:
                compiled.append(re.compile(pattern, re.IGNORECASE))
            except re.error as exc:
                logger.warning("Invalid mention pattern %r: %s", pattern, exc)
        return compiled

    @staticmethod
    def _load_allowed_users(extra: Dict[str, Any]) -> Set[str]:
        raw = extra.get("allowed_users")
        if not raw:
            return set()
        if isinstance(raw, list):
            items = [str(u).strip() for u in raw if str(u).strip()]
        else:
            items = [u.strip() for u in str(raw).split(",") if u.strip()]
        return {item.lower() for item in items}

    @staticmethod
    def _load_free_response_chats(extra: Dict[str, Any]) -> Set[str]:
        raw = extra.get("free_response_chats")
        if not raw:
            return set()
        if isinstance(raw, list):
            return {str(c).strip() for c in raw if str(c).strip()}
        return {c.strip() for c in str(raw).split(",") if c.strip()}

    def _is_user_allowed(self, sender_id: str, sender_staff_id: str) -> bool:
        if not self._allowed_users or "*" in self._allowed_users:
            return True
        candidates = {(sender_id or "").lower(), (sender_staff_id or "").lower()}
        candidates.discard("")
        return bool(candidates & self._allowed_users)

    def _message_mentions_bot(self, message: Any) -> bool:
        return bool(getattr(message, "is_in_at_list", False))

    def _message_matches_mention_patterns(self, text: str) -> bool:
        if not text or not self._mention_patterns:
            return False
        return any(p.search(text) for p in self._mention_patterns)

    def _should_process_message(
        self, message: Any, text: str, is_group: bool, chat_id: str
    ) -> bool:
        if not is_group:
            return True
        if chat_id and chat_id in self._free_response_chats:
            return True
        if not self._require_mention:
            return True
        if self._message_mentions_bot(message):
            return True
        return self._message_matches_mention_patterns(text)

    # ── Background task helper ───────────────────────────────────────

    def _spawn_bg(self, coro) -> None:
        task = asyncio.create_task(coro)
        self._bg_tasks.add(task)
        task.add_done_callback(self._bg_tasks.discard)

    # ── Inbound message processing ───────────────────────────────────

    async def _on_message(self, message: Any) -> None:
        """Process an incoming DingTalk chatbot message."""
        msg_id = getattr(message, "message_id", None) or uuid.uuid4().hex
        if self._dedup.is_duplicate(msg_id):
            logger.debug("[Connector:%s] Duplicate %s, skipping", self._account_id, msg_id)
            return

        conversation_id = getattr(message, "conversation_id", "") or ""
        conversation_type = getattr(message, "conversation_type", "1")
        is_group = str(conversation_type) == "2"
        sender_id = getattr(message, "sender_id", "") or ""
        sender_nick = getattr(message, "sender_nick", "") or sender_id
        sender_staff_id = getattr(message, "sender_staff_id", "") or ""

        chat_id = conversation_id or sender_id
        chat_type = "group" if is_group else "dm"

        # User allowlist gate
        if not self._is_user_allowed(sender_id, sender_staff_id):
            logger.debug(
                "[Connector:%s] Dropping message from non-allowed user %s",
                self._account_id,
                sender_staff_id or sender_id,
            )
            return

        # Extract text early for mention pattern matching
        text = self._extract_text(message) or ""

        # Group mention gate
        if not self._should_process_message(message, text, is_group, chat_id):
            logger.debug(
                "[Connector:%s] Dropping group message (mention gate) %s",
                self._account_id,
                msg_id,
            )
            return

        # Store message context
        if chat_id:
            self._message_contexts[chat_id] = message
            self._done_emoji_fired.discard(chat_id)

        # Cache session webhook
        session_webhook = getattr(message, "session_webhook", None) or ""
        session_webhook_expired_time = getattr(message, "session_webhook_expired_time", 0) or 0
        if session_webhook and chat_id and _DINGTALK_WEBHOOK_RE.match(session_webhook):
            if len(self._session_webhooks) >= _SESSION_WEBHOOKS_MAX:
                try:
                    self._session_webhooks.pop(next(iter(self._session_webhooks)))
                except StopIteration:
                    pass
            self._session_webhooks[chat_id] = (session_webhook, session_webhook_expired_time)

        # Debug: dump raw message structure for media diagnosis
        raw_msg_type = getattr(message, "message_type", None) or getattr(message, "msgtype", None)
        raw_image_content = getattr(message, "image_content", None)
        raw_rich_text = getattr(message, "rich_text_content", None)
        logger.info(
            "[Connector:%s] Raw message debug: type=%s, has_image_content=%s, "
            "rich_text_content=%s, rich_text_type=%s",
            self._account_id,
            raw_msg_type,
            raw_image_content is not None,
            repr(raw_rich_text)[:300] if raw_rich_text else "None",
            type(raw_rich_text).__name__ if raw_rich_text else "None",
        )

        # Resolve media download codes to URLs
        await self._resolve_media_codes(message)

        # Re-extract text after media resolution
        text = self._extract_text(message) or ""

        # Extract media
        msg_type, media_urls, media_types = self._extract_media(message)

        logger.info(
            "[Connector:%s] After extract: msg_type=%s, media_urls=%s, media_types=%s",
            self._account_id,
            msg_type,
            media_urls[:3] if media_urls else [],
            media_types[:3] if media_types else [],
        )

        if not text and not media_urls:
            logger.debug("[Connector:%s] Empty message, skipping", self._account_id)
            return

        # Download media to local cache so Hermes vision pipeline can read them
        if media_urls:
            media_urls, media_types = await self._download_media_to_cache(
                media_urls, media_types
            )

        # Build SessionSource
        source = self.build_source(
            chat_id=chat_id,
            chat_name=getattr(message, "conversation_title", None),
            chat_type=chat_type,
            user_id=sender_id,
            user_name=sender_nick,
            user_id_alt=sender_staff_id if sender_staff_id else None,
        )

        # Parse timestamp
        create_at = getattr(message, "create_at", None)
        try:
            timestamp = (
                datetime.fromtimestamp(int(create_at) / 1000, tz=timezone.utc)
                if create_at
                else datetime.now(tz=timezone.utc)
            )
        except (ValueError, OSError, TypeError):
            timestamp = datetime.now(tz=timezone.utc)

        event = MessageEvent(
            text=text,
            message_type=msg_type,
            source=source,
            message_id=msg_id,
            raw_message=message,
            media_urls=media_urls,
            media_types=media_types,
            timestamp=timestamp,
        )

        logger.info(
            "[Connector:%s] Message from %s in %s: %s",
            self._account_id,
            sender_nick,
            chat_id[:20] if chat_id else "?",
            text[:80] if text else "(media)",
        )
        await self.handle_message(event)

    # ── Text extraction ──────────────────────────────────────────────

    @staticmethod
    def _extract_text(message: Any) -> str:
        """Extract plain text from a DingTalk chatbot message.

        Handles both legacy dict and SDK dataclass payload shapes.
        """
        text = getattr(message, "text", None) or ""

        if hasattr(text, "content"):
            content = (text.content or "").strip()
        elif isinstance(text, dict):
            content = text.get("content", "").strip()
        else:
            content = str(text).strip()

        if not content:
            rich_text = getattr(message, "rich_text_content", None) or getattr(
                message, "rich_text", None
            )
            if rich_text:
                rich_list = getattr(rich_text, "rich_text_list", None) or rich_text
                if isinstance(rich_list, list):
                    parts = []
                    for item in rich_list:
                        if isinstance(item, dict):
                            part_text = item.get("text") or item.get("content") or ""
                            if part_text:
                                parts.append(part_text)
                        elif hasattr(item, "text") and item.text:
                            parts.append(item.text)
                    content = " ".join(parts).strip()

        return content

    # ── Media extraction ─────────────────────────────────────────────

    def _extract_media(self, message: Any):
        """Extract media info. Returns (MessageType, [urls], [mime_types])."""
        msg_type = MessageType.TEXT
        media_urls = []
        media_types = []

        # Single image
        image_content = getattr(message, "image_content", None)
        if image_content:
            download_code = getattr(image_content, "download_code", None)
            if download_code:
                media_urls.append(download_code)
                media_types.append("image")
                msg_type = MessageType.PHOTO

        # Rich text with mixed content
        rich_text = getattr(message, "rich_text_content", None) or getattr(
            message, "rich_text", None
        )
        if rich_text:
            rich_list = getattr(rich_text, "rich_text_list", None) or rich_text
            if isinstance(rich_list, list):
                for item in rich_list:
                    if isinstance(item, dict):
                        dl_code = (
                            item.get("downloadCode")
                            or item.get("pictureDownloadCode")
                            or item.get("download_code")
                            or ""
                        )
                        item_type = item.get("type", "")
                        if dl_code:
                            mapped = DINGTALK_TYPE_MAPPING.get(item_type, "file")
                            media_urls.append(dl_code)
                            if mapped == "image":
                                media_types.append("image")
                                if msg_type == MessageType.TEXT:
                                    msg_type = MessageType.PHOTO
                            elif mapped == "audio":
                                media_types.append("audio")
                                if msg_type == MessageType.TEXT:
                                    msg_type = MessageType.AUDIO
                            elif mapped == "video":
                                media_types.append("video")
                                if msg_type == MessageType.TEXT:
                                    msg_type = MessageType.VIDEO
                            else:
                                media_types.append("application/octet-stream")
                                if msg_type == MessageType.TEXT:
                                    msg_type = MessageType.DOCUMENT

        msg_type_str = getattr(message, "message_type", "") or ""
        if msg_type_str == "picture" and not media_urls:
            msg_type = MessageType.PHOTO
        elif msg_type_str == "richText":
            msg_type = (
                MessageType.PHOTO
                if any("image" in t for t in media_types)
                else MessageType.TEXT
            )

        return msg_type, media_urls, media_types

    # ── Media download to local cache ────────────────────────────────

    async def _download_media_to_cache(
        self,
        media_urls: List[str],
        media_types: List[str],
    ) -> tuple[List[str], List[str]]:
        """Download remote media files to local cache for Hermes vision pipeline.

        Hermes's GatewayRunner._handle_message expects media_urls to be
        local file paths (e.g. /Users/xxx/.hermes/cache/images/img_xxx.jpg).
        DingTalk provides temporary download URLs that need authentication,
        so we download them first and return local paths.

        Returns updated (media_urls, media_types) with local file paths.
        """
        if not self._http_client or not media_urls:
            return media_urls, media_types

        token = await self._get_access_token()
        cached_urls: List[str] = []
        cached_types: List[str] = []

        for i, url in enumerate(media_urls):
            mtype = media_types[i] if i < len(media_types) else ""

            # Skip if already a local path
            if url.startswith("/") or url.startswith("file://"):
                cached_urls.append(url)
                cached_types.append(mtype)
                continue

            # Determine file extension from media type
            ext = self._media_type_to_ext(mtype, url)

            try:
                if url.startswith("http://") or url.startswith("https://"):
                    # Direct URL — download with auth header if we have a token
                    headers = {
                        "User-Agent": "ConnectorDingTalkAdapter/1.0",
                        "Accept": "*/*",
                    }
                    if token:
                        headers["x-acs-dingtalk-access-token"] = token

                    response = await self._http_client.get(
                        url, headers=headers, timeout=30.0, follow_redirects=True
                    )
                    response.raise_for_status()

                    if mtype.startswith("image") or mtype == "image":
                        local_path = cache_image_from_bytes(response.content, ext)
                        cached_urls.append(local_path)
                        cached_types.append(f"image/{ext.lstrip('.')}")
                    else:
                        # Non-image media: save to cache dir with appropriate extension
                        local_path = self._save_media_to_cache(response.content, ext)
                        cached_urls.append(local_path)
                        cached_types.append(mtype)

                    logger.debug(
                        "[Connector:%s] Cached media %s → %s",
                        self._account_id,
                        url[:60],
                        local_path,
                    )
                else:
                    # Not a URL — likely a downloadCode that wasn't resolved.
                    # Try to resolve it via the robot SDK and download.
                    resolved_url = await self._resolve_single_download_code(url)
                    if resolved_url:
                        try:
                            headers = {
                                "User-Agent": "ConnectorDingTalkAdapter/1.0",
                                "Accept": "*/*",
                            }
                            if token:
                                headers["x-acs-dingtalk-access-token"] = token
                            response = await self._http_client.get(
                                resolved_url, headers=headers,
                                timeout=30.0, follow_redirects=True,
                            )
                            response.raise_for_status()
                            ext = self._media_type_to_ext(mtype, resolved_url)
                            if mtype.startswith("image") or mtype == "image":
                                local_path = cache_image_from_bytes(response.content, ext)
                            else:
                                local_path = self._save_media_to_cache(response.content, ext)
                            cached_urls.append(local_path)
                            cached_types.append(mtype if "/" in mtype else f"image/{ext.lstrip('.')}")
                            logger.info(
                                "[Connector:%s] Resolved+cached downloadCode → %s",
                                self._account_id, local_path,
                            )
                            continue
                        except Exception as dl_exc:
                            logger.warning(
                                "[Connector:%s] Failed to download resolved URL %s: %s",
                                self._account_id, resolved_url[:80], dl_exc,
                            )
                    else:
                        logger.warning(
                            "[Connector:%s] Unresolved media reference: %s",
                            self._account_id, url[:60],
                        )
                    cached_urls.append(url)
                    cached_types.append(mtype)

            except Exception as exc:
                logger.warning(
                    "[Connector:%s] Failed to cache media %s: %s",
                    self._account_id,
                    url[:60],
                    exc,
                )
                # Keep original URL as fallback
                cached_urls.append(url)
                cached_types.append(mtype)

        return cached_urls, cached_types

    @staticmethod
    def _media_type_to_ext(mtype: str, url: str) -> str:
        """Determine file extension from media type or URL."""
        type_ext_map = {
            "image": ".jpg",
            "image/jpeg": ".jpg",
            "image/jpg": ".jpg",
            "image/png": ".png",
            "image/gif": ".gif",
            "image/webp": ".webp",
            "audio": ".ogg",
            "audio/ogg": ".ogg",
            "audio/mp3": ".mp3",
            "audio/wav": ".wav",
            "audio/amr": ".amr",
            "video": ".mp4",
            "video/mp4": ".mp4",
        }
        ext = type_ext_map.get(mtype, "")
        if ext:
            return ext

        # Try to extract from URL
        from urllib.parse import urlparse
        path = urlparse(url).path
        if "." in path:
            url_ext = "." + path.rsplit(".", 1)[-1].lower()
            if len(url_ext) <= 5:
                return url_ext

        return ".bin"

    @staticmethod
    def _save_media_to_cache(data: bytes, ext: str) -> str:
        """Save non-image media bytes to the cache directory."""
        cache_dir = get_image_cache_dir()
        filename = f"media_{uuid.uuid4().hex[:12]}{ext}"
        filepath = cache_dir / filename
        filepath.write_bytes(data)
        return str(filepath)

    # ── Outbound messaging ───────────────────────────────────────────

    # Patterns for Hermes system messages that should NOT be forwarded to users.
    # These are internal framework notifications, not actual agent replies.
    _SYSTEM_MESSAGE_PATTERNS = (
        "◐ Session automatically reset",
        "📬 No home channel is set",
        "Use /resume to browse",
        "Type /sethome to make this chat",
    )

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        """Send a markdown reply via session webhook or AI Card."""
        # Filter out Hermes internal system messages (session reset, home channel prompts)
        if any(pattern in content for pattern in self._SYSTEM_MESSAGE_PATTERNS):
            logger.debug(
                "[Connector:%s] Suppressed system message: %s",
                self._account_id, content[:60],
            )
            return SendResult(success=True, message_id="suppressed")

        metadata = metadata or {}

        # Resolve session webhook
        session_webhook = metadata.get("session_webhook")
        if not session_webhook:
            webhook_info = self._get_valid_webhook(chat_id)
            if not webhook_info:
                logger.warning(
                    "[Connector:%s] No valid session_webhook for chat %s",
                    self._account_id,
                    chat_id,
                )
                return SendResult(
                    success=False,
                    error="No valid session_webhook available",
                )
            session_webhook, _ = webhook_info

        if not self._http_client:
            return SendResult(success=False, error="HTTP client not initialized")

        current_message = self._message_contexts.get(chat_id)
        is_final_reply = reply_to is not None

        # Try AI Card first
        if self._card_template_id and current_message and self._card_sdk:
            await self._close_streaming_siblings(chat_id)
            result = await self._create_and_stream_card(
                chat_id, current_message, content, finalize=is_final_reply
            )
            if result and result.success:
                if is_final_reply:
                    self._fire_done_reaction(chat_id)
                else:
                    self._streaming_cards.setdefault(chat_id, {})[
                        result.message_id
                    ] = content
                return result
            logger.warning("[Connector:%s] AI Card failed, falling back to webhook", self._account_id)

        # Webhook fallback
        normalized = self._normalize_markdown(content[: self.MAX_MESSAGE_LENGTH])
        payload = {
            "msgtype": "markdown",
            "markdown": {"title": "Connector", "text": normalized},
        }

        try:
            resp = await self._http_client.post(
                session_webhook, json=payload, timeout=15.0
            )
            if resp.status_code < 300:
                if is_final_reply:
                    self._fire_done_reaction(chat_id)
                return SendResult(success=True, message_id=uuid.uuid4().hex[:12])
            body = resp.text
            logger.warning(
                "[Connector:%s] Send failed HTTP %d: %s",
                self._account_id,
                resp.status_code,
                body[:200],
            )
            return SendResult(
                success=False, error=f"HTTP {resp.status_code}: {body[:200]}"
            )
        except Exception as exc:
            logger.error("[Connector:%s] Send error: %s", self._account_id, exc)
            return SendResult(success=False, error=str(exc))

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        """DingTalk does not support typing indicators."""
        pass

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {
            "name": chat_id,
            "type": "group" if "group" in chat_id.lower() else "dm",
        }

    # ── AI Card lifecycle ────────────────────────────────────────────

    async def edit_message(
        self,
        chat_id: str,
        message_id: str,
        content: str,
        *,
        finalize: bool = False,
    ) -> SendResult:
        """Edit an AI Card by streaming updated content."""
        if not message_id:
            return SendResult(success=False, error="message_id required")
        token = await self._get_access_token()
        if not token:
            return SendResult(success=False, error="No access token")

        try:
            await self._stream_card_content(message_id, token, content, finalize=finalize)
            if finalize:
                self._streaming_cards.get(chat_id, {}).pop(message_id, None)
                if not self._streaming_cards.get(chat_id):
                    self._streaming_cards.pop(chat_id, None)
                self._fire_done_reaction(chat_id)
            else:
                self._streaming_cards.setdefault(chat_id, {})[message_id] = content
            return SendResult(success=True, message_id=message_id)
        except Exception as exc:
            logger.warning("[Connector:%s] Card edit failed: %s", self._account_id, exc)
            return SendResult(success=False, error=str(exc))

    async def _close_streaming_siblings(self, chat_id: str) -> None:
        cards = self._streaming_cards.pop(chat_id, None)
        if not cards:
            return
        token = await self._get_access_token()
        if not token:
            return
        for out_track_id, last_content in list(cards.items()):
            try:
                await self._stream_card_content(out_track_id, token, last_content, finalize=True)
            except Exception:
                pass

    def _fire_done_reaction(self, chat_id: str) -> None:
        if chat_id in self._done_emoji_fired:
            return
        self._done_emoji_fired.add(chat_id)
        msg = self._message_contexts.get(chat_id)
        if not msg:
            return
        msg_id = getattr(msg, "message_id", "") or ""
        conversation_id = getattr(msg, "conversation_id", "") or ""
        if not (msg_id and conversation_id):
            return

        async def _swap() -> None:
            await self._send_emotion(msg_id, conversation_id, "🤔Thinking", recall=True)
            await self._send_emotion(msg_id, conversation_id, "🥳Done", recall=False)

        self._spawn_bg(_swap())

    async def _create_and_stream_card(
        self,
        chat_id: str,
        message: Any,
        content: str,
        *,
        finalize: bool = True,
    ) -> Optional[SendResult]:
        """Create an AI Card and stream content."""
        if not CARD_SDK_AVAILABLE or not self._card_sdk:
            return None

        try:
            token = await self._get_access_token()
            if not token:
                return None

            out_track_id = f"connector_{uuid.uuid4().hex[:12]}"
            conversation_id = getattr(message, "conversation_id", "") or ""
            conversation_type = getattr(message, "conversation_type", "1")
            is_group = str(conversation_type) == "2"
            sender_staff_id = getattr(message, "sender_staff_id", "") or ""

            runtime = tea_util_models.RuntimeOptions()

            # Step 1: Create card (cardParamMap matches OpenClaw's card.ts)
            create_request = dingtalk_card_models.CreateCardRequest(
                card_template_id=self._card_template_id,
                out_track_id=out_track_id,
                card_data=dingtalk_card_models.CreateCardRequestCardData(
                    card_param_map={
                        "config": json.dumps({"autoLayout": True}),
                    },
                ),
                callback_type="STREAM",
                im_group_open_space_model=dingtalk_card_models.CreateCardRequestImGroupOpenSpaceModel(
                    support_forward=True,
                ),
                im_robot_open_space_model=dingtalk_card_models.CreateCardRequestImRobotOpenSpaceModel(
                    support_forward=True,
                ),
            )
            create_headers = dingtalk_card_models.CreateCardHeaders(
                x_acs_dingtalk_access_token=token,
            )
            await self._card_sdk.create_card_with_options_async(
                create_request, create_headers, runtime
            )

            # Step 2: Deliver card
            if is_group:
                open_space_id = f"dtv1.card//IM_GROUP.{conversation_id}"
                deliver_request = dingtalk_card_models.DeliverCardRequest(
                    out_track_id=out_track_id,
                    user_id_type=1,
                    open_space_id=open_space_id,
                    im_group_open_deliver_model=dingtalk_card_models.DeliverCardRequestImGroupOpenDeliverModel(
                        robot_code=self._robot_code,
                    ),
                )
            else:
                if not sender_staff_id:
                    logger.warning(
                        "[Connector:%s] AI Card skipped: missing sender_staff_id for DM",
                        self._account_id,
                    )
                    return None
                open_space_id = f"dtv1.card//IM_ROBOT.{sender_staff_id}"
                deliver_request = dingtalk_card_models.DeliverCardRequest(
                    out_track_id=out_track_id,
                    user_id_type=1,
                    open_space_id=open_space_id,
                    im_robot_open_deliver_model=dingtalk_card_models.DeliverCardRequestImRobotOpenDeliverModel(
                        space_type="IM_ROBOT",
                    ),
                )

            deliver_headers = dingtalk_card_models.DeliverCardHeaders(
                x_acs_dingtalk_access_token=token,
            )
            await self._card_sdk.deliver_card_with_options_async(
                deliver_request, deliver_headers, runtime
            )

            # Step 3: Stream content
            await self._stream_card_content(out_track_id, token, content, finalize=finalize)

            logger.info(
                "[Connector:%s] AI Card %s: %s",
                self._account_id,
                "created+finalized" if finalize else "created (streaming)",
                out_track_id,
            )
            return SendResult(success=True, message_id=out_track_id)

        except Exception as exc:
            logger.warning(
                "[Connector:%s] AI Card create failed: %s\n%s",
                self._account_id,
                exc,
                traceback.format_exc(),
            )
            return None

    async def _stream_card_content(
        self,
        out_track_id: str,
        token: str,
        content: str,
        finalize: bool = False,
    ) -> None:
        stream_request = dingtalk_card_models.StreamingUpdateRequest(
            out_track_id=out_track_id,
            guid=str(uuid.uuid4()),
            key="msgContent",
            content=content[: self.MAX_MESSAGE_LENGTH],
            is_full=True,
            is_finalize=finalize,
            is_error=False,
        )
        stream_headers = dingtalk_card_models.StreamingUpdateHeaders(
            x_acs_dingtalk_access_token=token,
        )
        runtime = tea_util_models.RuntimeOptions()
        await self._card_sdk.streaming_update_with_options_async(
            stream_request, stream_headers, runtime
        )

    async def _get_access_token(self) -> Optional[str]:
        if not self._stream_client:
            return None
        try:
            token = await asyncio.to_thread(self._stream_client.get_access_token)
            return token
        except Exception as exc:
            logger.error("[Connector:%s] Failed to get access token: %s", self._account_id, exc)
            return None

    # ── Emoji reactions ──────────────────────────────────────────────

    async def _send_emotion(
        self,
        open_msg_id: str,
        open_conversation_id: str,
        emoji_name: str,
        *,
        recall: bool = False,
    ) -> None:
        if not self._robot_sdk or not open_msg_id or not open_conversation_id:
            return
        try:
            token = await self._get_access_token()
            if not token:
                return
            runtime = tea_util_models.RuntimeOptions()
            emotion_kwargs = {
                "robot_code": self._robot_code,
                "open_msg_id": open_msg_id,
                "open_conversation_id": open_conversation_id,
                "emotion_type": 2,
                "emotion_name": emoji_name,
            }
            if recall:
                emotion_kwargs["text_emotion"] = (
                    dingtalk_robot_models.RobotRecallEmotionRequestTextEmotion(
                        emotion_id="2659900",
                        emotion_name=emoji_name,
                        text=emoji_name,
                        background_id="im_bg_1",
                    )
                )
                request = dingtalk_robot_models.RobotRecallEmotionRequest(**emotion_kwargs)
                headers = dingtalk_robot_models.RobotRecallEmotionHeaders(
                    x_acs_dingtalk_access_token=token,
                )
                await self._robot_sdk.robot_recall_emotion_with_options_async(
                    request, headers, runtime
                )
            else:
                emotion_kwargs["text_emotion"] = (
                    dingtalk_robot_models.RobotReplyEmotionRequestTextEmotion(
                        emotion_id="2659900",
                        emotion_name=emoji_name,
                        text=emoji_name,
                        background_id="im_bg_1",
                    )
                )
                request = dingtalk_robot_models.RobotReplyEmotionRequest(**emotion_kwargs)
                headers = dingtalk_robot_models.RobotReplyEmotionHeaders(
                    x_acs_dingtalk_access_token=token,
                )
                await self._robot_sdk.robot_reply_emotion_with_options_async(
                    request, headers, runtime
                )
        except Exception:
            logger.debug(
                "[Connector:%s] Emotion %s failed",
                self._account_id,
                "recall" if recall else "reply",
                exc_info=True,
            )

    # ── Media code resolution ────────────────────────────────────────

    async def _resolve_media_codes(self, message: Any) -> None:
        """Resolve download codes to actual URLs."""
        token = await self._get_access_token()
        if not token:
            return

        robot_code = getattr(message, "robot_code", None) or self._client_id
        codes_to_resolve = []

        img_content = getattr(message, "image_content", None)
        if img_content and getattr(img_content, "download_code", None):
            codes_to_resolve.append((img_content, "download_code"))

        rich_text = getattr(message, "rich_text_content", None)
        if rich_text:
            # rich_text may be a list directly or an object with rich_text_list
            rich_list = (
                rich_text
                if isinstance(rich_text, list)
                else getattr(rich_text, "rich_text_list", None) or []
            )
            for item in rich_list:
                if isinstance(item, dict):
                    for key in ("downloadCode", "pictureDownloadCode", "download_code"):
                        if item.get(key):
                            codes_to_resolve.append((item, key))

        if not codes_to_resolve:
            return

        tasks = [
            self._fetch_download_url(
                getattr(obj, key, None) if hasattr(obj, key) else obj.get(key),
                robot_code,
                token,
                obj,
                key,
            )
            for obj, key in codes_to_resolve
        ]
        await asyncio.gather(*tasks, return_exceptions=True)

    async def _fetch_download_url(
        self, code: str, robot_code: str, token: str, obj: Any, key: str
    ) -> None:
        if not self._robot_sdk or not code:
            return
        try:
            request = dingtalk_robot_models.RobotMessageFileDownloadRequest(
                download_code=code,
                robot_code=robot_code,
            )
            headers = dingtalk_robot_models.RobotMessageFileDownloadHeaders(
                x_acs_dingtalk_access_token=token,
            )
            runtime = tea_util_models.RuntimeOptions()
            response = await self._robot_sdk.robot_message_file_download_with_options_async(
                request, headers, runtime
            )
            body = response.body if response else None
            if body:
                url = getattr(body, "download_url", None)
                if url:
                    if hasattr(obj, key):
                        setattr(obj, key, url)
                    elif isinstance(obj, dict):
                        obj[key] = url
        except Exception as exc:
            logger.error("[Connector:%s] Media resolve error for %s: %s", self._account_id, code, exc)

    async def _resolve_single_download_code(self, code: str) -> Optional[str]:
        """Resolve a single downloadCode to a download URL via the robot SDK.

        Used as a fallback in _download_media_to_cache when the code was not
        resolved during the earlier _resolve_media_codes pass.
        """
        if not self._robot_sdk or not code:
            return None
        token = await self._get_access_token()
        if not token:
            return None
        robot_code = self._robot_code or self._client_id
        try:
            request = dingtalk_robot_models.RobotMessageFileDownloadRequest(
                download_code=code,
                robot_code=robot_code,
            )
            headers = dingtalk_robot_models.RobotMessageFileDownloadHeaders(
                x_acs_dingtalk_access_token=token,
            )
            runtime = tea_util_models.RuntimeOptions()
            response = await self._robot_sdk.robot_message_file_download_with_options_async(
                request, headers, runtime
            )
            body = response.body if response else None
            if body:
                url = getattr(body, "download_url", None)
                if url:
                    logger.debug(
                        "[Connector:%s] Resolved downloadCode → %s",
                        self._account_id, url[:80],
                    )
                    return url
        except Exception as exc:
            logger.warning(
                "[Connector:%s] Failed to resolve downloadCode: %s",
                self._account_id, exc,
            )
        return None

    # ── Helpers ──────────────────────────────────────────────────────

    def _get_valid_webhook(self, chat_id: str) -> Optional[tuple[str, int]]:
        info = self._session_webhooks.get(chat_id)
        if not info:
            return None
        webhook, expired_time_ms = info
        if expired_time_ms and expired_time_ms > 0:
            now_ms = int(datetime.now(tz=timezone.utc).timestamp() * 1000)
            safety_margin_ms = 5 * 60 * 1000
            if now_ms + safety_margin_ms >= expired_time_ms:
                self._session_webhooks.pop(chat_id, None)
                return None
        return info

    @staticmethod
    def _normalize_markdown(text: str) -> str:
        """Normalize markdown for DingTalk's renderer."""
        lines = text.split("\n")
        out = []
        for i, line in enumerate(lines):
            is_numbered = re.match(r"^\d+\.\s", line.strip())
            if is_numbered and i > 0:
                prev = lines[i - 1]
                if prev.strip() and not re.match(r"^\d+\.\s", prev.strip()):
                    out.append("")
            if line.strip().startswith("```") and line != line.lstrip():
                indent = len(line) - len(line.lstrip())
                line = line[indent:]
            out.append(line)
        return "\n".join(out)


# ── Incoming message handler ─────────────────────────────────────────

class _IncomingHandler(
    dingtalk_stream.ChatbotHandler if DINGTALK_STREAM_AVAILABLE else object
):
    """dingtalk-stream ChatbotHandler that forwards messages to the adapter."""

    def __init__(
        self,
        adapter: ConnectorDingTalkAdapter,
        loop: Optional[asyncio.AbstractEventLoop] = None,
    ):
        if DINGTALK_STREAM_AVAILABLE:
            super().__init__()
        self._adapter = adapter
        self._loop = loop

    async def process(self, message: Any):
        """Called by dingtalk-stream (>=0.20) when a message arrives."""
        try:
            data = message.data
            if isinstance(data, str):
                data = json.loads(data)

            # Debug: log raw data keys and msgtype to diagnose media issues
            if isinstance(data, dict):
                raw_msgtype = data.get("msgtype") or data.get("message_type") or data.get("messageType") or "unknown"
                logger.info(
                    "[Connector] Raw data: msgtype=%s, keys=%s, content_preview=%s",
                    raw_msgtype,
                    sorted(data.keys())[:20],
                    {k: repr(v)[:100] for k, v in data.items()
                     if k in ("msgtype", "messageType", "message_type", "content",
                              "imageContent", "image_content", "richTextContent",
                              "rich_text_content", "text")},
                )

            chatbot_msg = ChatbotMessage.from_dict(data)

            # Ensure session_webhook is populated
            if not getattr(chatbot_msg, "session_webhook", None):
                webhook = (
                    data.get("sessionWebhook") or data.get("session_webhook") or ""
                ) if isinstance(data, dict) else ""
                if webhook:
                    chatbot_msg.session_webhook = webhook

            # Ensure is_in_at_list is populated
            if not getattr(chatbot_msg, "is_in_at_list", False):
                raw_flag = data.get("isInAtList") if isinstance(data, dict) else False
                if raw_flag:
                    chatbot_msg.is_in_at_list = True

            msg_id = getattr(chatbot_msg, "message_id", None) or ""
            conversation_id = getattr(chatbot_msg, "conversation_id", None) or ""

            # Thinking reaction
            if msg_id and conversation_id:
                self._adapter._spawn_bg(
                    self._adapter._send_emotion(msg_id, conversation_id, "🤔Thinking", recall=False)
                )

            # Process in background to avoid blocking heartbeat
            asyncio.create_task(self._safe_on_message(chatbot_msg))

        except Exception:
            logger.exception("[Connector] Error preparing incoming message")
            return AckMessage.STATUS_SYSTEM_EXCEPTION, "error"

        return AckMessage.STATUS_OK, "OK"

    async def _safe_on_message(self, chatbot_msg: Any) -> None:
        try:
            await self._adapter._on_message(chatbot_msg)
        except Exception:
            logger.exception("[Connector] Error processing incoming message")
