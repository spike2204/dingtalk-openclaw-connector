"""
Launcher for the Connector DingTalk → Hermes adapter.

This module provides the entry point for starting the DingTalk adapter
that routes messages to Hermes Agent for processing, independent of
Hermes's built-in DingTalkAdapter.

Usage:
    # Standalone (requires HERMES_PATH or --hermes-path)
    cd hermes-adapter
    python launcher.py --hermes-path /path/to/hermes-agent

    # With environment variables
    HERMES_PATH=/path/to/hermes-agent \
    DINGTALK_CLIENT_ID=xxx \
    DINGTALK_CLIENT_SECRET=yyy \
    python launcher.py
"""

import argparse
import asyncio
import logging
import os
import signal
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger("hermes_adapter")


def _setup_hermes_path(hermes_path: Path) -> None:
    """Add the Hermes agent repository root to sys.path.

    This makes ``from gateway.xxx import ...`` available without
    installing Hermes as a package.
    """
    hermes_str = str(hermes_path)
    if hermes_str not in sys.path:
        sys.path.insert(0, hermes_str)
        logger.debug("Added Hermes path to sys.path: %s", hermes_str)


def _inject_dws_env(config: Dict[str, Any], accounts: Optional[List[Any]] = None) -> None:
    """Inject DWS credentials into environment for skill integration.

    OpenClaw uses the bot's own clientId/clientSecret as DWS credentials.
    We follow the same pattern: if no explicit dws_client_id/dws_client_secret
    is configured, fall back to the first account's DingTalk credentials.
    """
    dws_client_id = config.get("dws_client_id") or os.environ.get("DWS_CLIENT_ID", "")
    dws_client_secret = config.get("dws_client_secret") or os.environ.get("DWS_CLIENT_SECRET", "")

    # Fall back to the first bot account's credentials (same as OpenClaw)
    if not dws_client_id and accounts:
        dws_client_id = getattr(accounts[0], "client_id", "") or ""
    if not dws_client_secret and accounts:
        dws_client_secret = getattr(accounts[0], "client_secret", "") or ""

    if dws_client_id:
        os.environ["DWS_CLIENT_ID"] = dws_client_id
    if dws_client_secret:
        os.environ["DWS_CLIENT_SECRET"] = dws_client_secret
    # Mark the calling context for dws CLI (same as OpenClaw)
    os.environ.setdefault("DINGTALK_AGENT", "DING_DWS_CLAW")
    os.environ.setdefault("DWS_CHANNEL", "openclaw")


def _setup_logging(verbose: bool = False) -> None:
    """Configure logging for the adapter."""
    level = logging.DEBUG if verbose else logging.INFO
    formatter = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    root_logger = logging.getLogger()
    root_logger.setLevel(level)

    if not root_logger.handlers:
        handler = logging.StreamHandler(sys.stderr)
        handler.setLevel(level)
        handler.setFormatter(formatter)
        root_logger.addHandler(handler)


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description="Connector DingTalk adapter for Hermes Agent",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--hermes-path",
        type=str,
        default=None,
        help="Path to the Hermes agent repository (default: HERMES_PATH env or ../hermes-agent)",
    )
    parser.add_argument(
        "--config",
        type=str,
        default=None,
        help="Path to config.yaml (default: hermes-adapter/config.yaml)",
    )
    parser.add_argument(
        "--client-id",
        type=str,
        default=None,
        help="DingTalk App Key (overrides config/env)",
    )
    parser.add_argument(
        "--client-secret",
        type=str,
        default=None,
        help="DingTalk App Secret (overrides config/env)",
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        default=False,
        help="Enable verbose/debug logging",
    )
    return parser.parse_args(argv)


async def run_adapter(args: argparse.Namespace) -> bool:
    """Start the Connector adapter(s) and run until interrupted.

    This function:
    1. Resolves the Hermes path and adds it to sys.path
    2. Resolves DingTalk account credentials (supports multiple accounts)
    3. For each account, creates a GatewayRunner with only DINGTALK enabled
    4. Overrides _create_adapter to return our ConnectorDingTalkAdapter
    5. Starts all runners in parallel and waits for shutdown

    Returns True if at least one adapter ran successfully.
    """
    # Step 1: Resolve Hermes path
    from config_bridge import resolve_hermes_path

    hermes_path = resolve_hermes_path(args.hermes_path)
    _setup_hermes_path(hermes_path)

    # Step 2: Override env vars from CLI args
    if args.client_id:
        os.environ["DINGTALK_CLIENT_ID"] = args.client_id
    if args.client_secret:
        os.environ["DINGTALK_CLIENT_SECRET"] = args.client_secret

    # Step 3: Resolve accounts
    from config_bridge import resolve_accounts, build_platform_config

    accounts = resolve_accounts(config_path=args.config)
    if not accounts:
        logger.error(
            "No DingTalk accounts configured. "
            "Set DINGTALK_CLIENT_ID/DINGTALK_CLIENT_SECRET env vars, "
            "or create a config.yaml with accounts section."
        )
        return False

    logger.info(
        "Resolved %d DingTalk account(s): %s",
        len(accounts),
        [a.account_id for a in accounts],
    )

    # Step 4: Inject DWS env — use bot credentials as DWS credentials (same as OpenClaw)
    yaml_config = {}
    try:
        from config_bridge import load_yaml_config
        yaml_config = load_yaml_config(args.config)
    except Exception:
        pass
    _inject_dws_env(yaml_config, accounts=accounts)

    # Step 5: Import Hermes modules (now that sys.path is set)
    from gateway.config import Platform, GatewayConfig, load_gateway_config
    from gateway.run import GatewayRunner
    from gateway.platforms.base import BasePlatformAdapter

    # Import our adapter
    from connector_adapter import ConnectorDingTalkAdapter

    # Step 6: Build one GatewayRunner per account
    # GatewayRunner.adapters is keyed by Platform enum, so one runner
    # can only hold one adapter per platform.  For multi-account we
    # create independent runners that share the same Hermes config
    # but each connect a different DingTalk bot.
    runners: List[Any] = []

    for account in accounts:
        platform_config = build_platform_config(account)

        # Load the base gateway config (model, terminal, etc.)
        try:
            gateway_config = load_gateway_config()
        except Exception:
            gateway_config = GatewayConfig()

        # Only enable DINGTALK for this runner
        gateway_config.platforms = {
            Platform.DINGTALK: platform_config,
        }

        # Capture account in closure
        _account = account

        class ConnectorGatewayRunner(GatewayRunner):
            """GatewayRunner that uses ConnectorDingTalkAdapter for DingTalk."""

            _bound_account = _account

            def _create_adapter(
                self,
                platform: Platform,
                config: Any,
            ) -> Optional[BasePlatformAdapter]:
                if platform == Platform.DINGTALK:
                    return ConnectorDingTalkAdapter(
                        config,
                        account_id=self._bound_account.account_id,
                    )
                return super()._create_adapter(platform, config)

        runner = ConnectorGatewayRunner(gateway_config)
        runners.append((runner, account))

    # Step 7: Set up signal handlers for graceful shutdown
    loop = asyncio.get_running_loop()
    shutdown_triggered = False

    def trigger_shutdown():
        nonlocal shutdown_triggered
        if shutdown_triggered:
            return
        shutdown_triggered = True
        logger.info("Shutdown signal received, stopping all adapters...")
        loop.create_task(_shutdown_all(runners))

    for sig_name in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig_name, trigger_shutdown)

    # Step 8: Start all runners in parallel
    logger.info("Starting Connector DingTalk → Hermes adapter...")
    logger.info("  Hermes: %s", hermes_path)
    for _, account in runners:
        logger.info("  Account: %s (%s)", account.account_id, account.name or account.client_id[:8])

    start_results = await asyncio.gather(
        *(runner.start() for runner, _ in runners),
        return_exceptions=True,
    )

    connected_count = sum(
        1 for result in start_results
        if result is True
    )
    for i, result in enumerate(start_results):
        account_id = runners[i][1].account_id
        if isinstance(result, Exception):
            logger.error("Account '%s' failed to start: %s", account_id, result)
        elif not result:
            logger.warning("Account '%s' failed to connect", account_id)
        else:
            logger.info("Account '%s' connected successfully", account_id)

    if connected_count == 0:
        logger.error("No adapters connected successfully")
        return False

    logger.info(
        "%d/%d adapter(s) started, waiting for messages...",
        connected_count,
        len(runners),
    )

    # Step 9: Wait for any runner to request shutdown
    shutdown_tasks = [
        asyncio.create_task(runner.wait_for_shutdown())
        for runner, _ in runners
        if runner.adapters
    ]
    if shutdown_tasks:
        await asyncio.wait(shutdown_tasks, return_when=asyncio.FIRST_COMPLETED)

    # Clean up remaining runners
    if not shutdown_triggered:
        await _shutdown_all(runners)

    logger.info("All adapters stopped")
    return True


async def _shutdown_all(runners: List) -> None:
    """Gracefully shut down all runners."""
    for runner, account in runners:
        try:
            for adapter in runner.adapters.values():
                try:
                    await adapter.disconnect()
                except Exception as exc:
                    logger.warning(
                        "Error disconnecting adapter for '%s': %s",
                        account.account_id,
                        exc,
                    )
        except Exception as exc:
            logger.warning("Error during shutdown of '%s': %s", account.account_id, exc)
        finally:
            runner._shutdown_event.set()


def main(argv: Optional[List[str]] = None) -> None:
    """CLI entry point."""
    args = parse_args(argv)
    _setup_logging(verbose=args.verbose)

    # Ensure the adapter's own directory is on sys.path for local imports
    adapter_dir = str(Path(__file__).resolve().parent)
    if adapter_dir not in sys.path:
        sys.path.insert(0, adapter_dir)

    try:
        success = asyncio.run(run_adapter(args))
    except KeyboardInterrupt:
        logger.info("Interrupted by user")
        success = True

    if not success:
        sys.exit(1)


if __name__ == "__main__":
    main()
