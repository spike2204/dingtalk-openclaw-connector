"""
Configuration bridge for the Hermes adapter.

Reads DingTalk credentials from environment variables or a YAML config file,
and constructs a Hermes-compatible PlatformConfig instance.
"""

import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

CONFIG_FILE_NAME = "config.yaml"


@dataclass
class DingTalkAccountConfig:
    """Resolved configuration for a single DingTalk bot account."""

    account_id: str
    client_id: str
    client_secret: str
    name: Optional[str] = None
    require_mention: bool = False
    card_template_id: Optional[str] = None
    allowed_users: Optional[List[str]] = None
    free_response_chats: Optional[List[str]] = None
    mention_patterns: Optional[List[str]] = None
    extra: Dict[str, Any] = field(default_factory=dict)


def load_yaml_config(config_path: Optional[str] = None) -> Dict[str, Any]:
    """Load configuration from a YAML file.

    Searches in order:
    1. Explicit *config_path* argument
    2. ``HERMES_ADAPTER_CONFIG`` environment variable
    3. ``hermes-adapter/config.yaml`` relative to this file's parent
    """
    import yaml

    candidates = []
    if config_path:
        candidates.append(Path(config_path))

    env_path = os.environ.get("HERMES_ADAPTER_CONFIG")
    if env_path:
        candidates.append(Path(env_path))

    candidates.append(Path(__file__).parent / CONFIG_FILE_NAME)

    for path in candidates:
        if path.exists():
            logger.info("Loading config from %s", path)
            with open(path, encoding="utf-8") as fh:
                return yaml.safe_load(fh) or {}

    return {}


def resolve_accounts_from_env() -> List[DingTalkAccountConfig]:
    """Resolve a single account from environment variables.

    Environment variables:
    - ``DINGTALK_CLIENT_ID`` — App Key
    - ``DINGTALK_CLIENT_SECRET`` — App Secret
    - ``DINGTALK_REQUIRE_MENTION`` — whether group chats need @bot
    - ``DINGTALK_CARD_TEMPLATE_ID`` — AI Card template (optional)
    - ``DINGTALK_ALLOWED_USERS`` — comma-separated allowed user IDs
    """
    client_id = os.environ.get("DINGTALK_CLIENT_ID", "").strip()
    client_secret = os.environ.get("DINGTALK_CLIENT_SECRET", "").strip()

    if not client_id or not client_secret:
        return []

    require_mention_raw = os.environ.get("DINGTALK_REQUIRE_MENTION", "false")
    require_mention = require_mention_raw.lower() in ("true", "1", "yes", "on")

    card_template_id = os.environ.get("DINGTALK_CARD_TEMPLATE_ID", "").strip() or None

    allowed_users_raw = os.environ.get("DINGTALK_ALLOWED_USERS", "").strip()
    allowed_users = (
        [u.strip() for u in allowed_users_raw.split(",") if u.strip()]
        if allowed_users_raw
        else None
    )

    return [
        DingTalkAccountConfig(
            account_id="default",
            client_id=client_id,
            client_secret=client_secret,
            require_mention=require_mention,
            card_template_id=card_template_id,
            allowed_users=allowed_users,
        )
    ]


def resolve_accounts_from_yaml(config: Dict[str, Any]) -> List[DingTalkAccountConfig]:
    """Resolve accounts from a parsed YAML config dict.

    Expected YAML structure::

        accounts:
          bot-a:
            client_id: "dingXXX"
            client_secret: "secret"
            name: "助手A"
            require_mention: true
            card_template_id: "xxx.schema"
          bot-b:
            client_id: "dingYYY"
            client_secret: "secret2"
    """
    accounts_raw = config.get("accounts")
    if not accounts_raw or not isinstance(accounts_raw, dict):
        return []

    results: List[DingTalkAccountConfig] = []
    for account_id, account_cfg in accounts_raw.items():
        if not isinstance(account_cfg, dict):
            continue

        client_id = str(account_cfg.get("client_id", "")).strip()
        client_secret = str(account_cfg.get("client_secret", "")).strip()
        if not client_id or not client_secret:
            logger.warning("Account '%s' missing client_id or client_secret, skipping", account_id)
            continue

        enabled = account_cfg.get("enabled", True)
        if not enabled:
            logger.info("Account '%s' is disabled, skipping", account_id)
            continue

        allowed_users_raw = account_cfg.get("allowed_users")
        allowed_users = None
        if isinstance(allowed_users_raw, list):
            allowed_users = [str(u).strip() for u in allowed_users_raw if str(u).strip()]
        elif isinstance(allowed_users_raw, str) and allowed_users_raw.strip():
            allowed_users = [u.strip() for u in allowed_users_raw.split(",") if u.strip()]

        free_response_raw = account_cfg.get("free_response_chats")
        free_response_chats = None
        if isinstance(free_response_raw, list):
            free_response_chats = [str(c).strip() for c in free_response_raw if str(c).strip()]

        mention_patterns_raw = account_cfg.get("mention_patterns")
        mention_patterns = None
        if isinstance(mention_patterns_raw, list):
            mention_patterns = [str(p) for p in mention_patterns_raw if str(p).strip()]

        results.append(
            DingTalkAccountConfig(
                account_id=str(account_id),
                client_id=client_id,
                client_secret=client_secret,
                name=account_cfg.get("name"),
                require_mention=bool(account_cfg.get("require_mention", False)),
                card_template_id=account_cfg.get("card_template_id"),
                allowed_users=allowed_users,
                free_response_chats=free_response_chats,
                mention_patterns=mention_patterns,
                extra=account_cfg.get("extra", {}),
            )
        )

    return results


def resolve_accounts(
    config_path: Optional[str] = None,
) -> List[DingTalkAccountConfig]:
    """Resolve all DingTalk accounts from YAML config, falling back to env vars.

    Returns an empty list if no credentials are found anywhere.
    """
    yaml_config = load_yaml_config(config_path)
    accounts = resolve_accounts_from_yaml(yaml_config)
    if accounts:
        return accounts

    return resolve_accounts_from_env()


def build_platform_config(account: DingTalkAccountConfig) -> "PlatformConfig":
    """Build a Hermes PlatformConfig from a resolved account config.

    Dynamically imports ``gateway.config.PlatformConfig`` so this module
    works even before the Hermes path is added to ``sys.path``.
    """
    from gateway.config import PlatformConfig

    extra: Dict[str, Any] = {
        "client_id": account.client_id,
        "client_secret": account.client_secret,
        "require_mention": account.require_mention,
        **account.extra,
    }

    if account.card_template_id:
        extra["card_template_id"] = account.card_template_id
    if account.allowed_users:
        extra["allowed_users"] = account.allowed_users
    if account.free_response_chats:
        extra["free_response_chats"] = account.free_response_chats
    if account.mention_patterns:
        extra["mention_patterns"] = account.mention_patterns

    return PlatformConfig(enabled=True, extra=extra)


def resolve_hermes_path(cli_hermes_path: Optional[str] = None) -> Path:
    """Resolve the path to the Hermes agent repository.

    Searches in order:
    1. Explicit CLI argument
    2. ``HERMES_PATH`` environment variable
    3. ``../hermes-agent`` relative to this file (sibling directory)

    Raises:
        FileNotFoundError: If no valid Hermes path is found.
    """
    candidates = []
    if cli_hermes_path:
        candidates.append(Path(cli_hermes_path).expanduser().resolve())

    env_path = os.environ.get("HERMES_PATH", "").strip()
    if env_path:
        candidates.append(Path(env_path).expanduser().resolve())

    # Sibling directory convention: ../hermes-agent relative to connector repo
    connector_root = Path(__file__).resolve().parent.parent
    candidates.append(connector_root.parent / "hermes-agent")

    for path in candidates:
        gateway_init = path / "gateway" / "__init__.py"
        if gateway_init.exists():
            logger.info("Resolved Hermes path: %s", path)
            return path

    tried = ", ".join(str(p) for p in candidates)
    raise FileNotFoundError(
        f"Could not find Hermes agent repository. "
        f"Tried: {tried}. "
        f"Set HERMES_PATH env var or pass --hermes-path."
    )
