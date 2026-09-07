"""Event-loop policy hardening for Windows backends.

uvicorn does not always honor a pre-set Proactor policy (reload/workers paths
install their own loop factory) and older releases default to a
SelectorEventLoop on Windows. Selector loops do not support asyncio's
child-process APIs and have been observed to deadlock the whole API server
during knowledge-base indexing (incident 2026-09-08). Every backend launch
path — ``deeptutor serve``, ``deeptutor start``'s launcher subprocess, and
``deeptutor.api.run_server`` — must go through
:func:`ensure_proactor_event_loop` before uvicorn starts.
"""

from __future__ import annotations

import logging
import sys

_logger = logging.getLogger(__name__)


def ensure_proactor_event_loop() -> bool:
    """Force the Proactor event-loop policy on Windows.

    No-op on other platforms and safe to call repeatedly. Returns ``True``
    when no change was needed, ``False`` when a non-Proactor policy was
    replaced (also logged as a warning so a misconfigured launch is visible
    in the logs).
    """
    if sys.platform != "win32":
        return True

    import asyncio

    policy = asyncio.get_event_loop_policy()
    if isinstance(policy, asyncio.WindowsProactorEventLoopPolicy):
        return True

    _logger.warning(
        "Windows event-loop policy is %s; switching to WindowsProactorEventLoopPolicy "
        "(SelectorEventLoop breaks asyncio subprocess APIs and has deadlocked the "
        "API server during KB indexing — start backends via `deeptutor serve`, "
        "`deeptutor start`, or deeptutor.api.run_server).",
        type(policy).__name__,
    )
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    return False
