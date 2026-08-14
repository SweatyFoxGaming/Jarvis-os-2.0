"""
Regression coverage for src/api.py's async route handlers not blocking the
event loop. Plain asyncio.run()-driven tests, matching daemon/tests/
test_voice_engine.py's convention (no pytest-asyncio dependency) rather than
using anyio/pytest-asyncio markers, to keep this project's two Python test
suites consistent.
"""
import asyncio
import os
import sys
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

os.environ.setdefault("INTERNAL_API_KEY", "test-only-not-a-real-secret")

import api  # noqa: E402


def _run(coro):
    return asyncio.run(coro)


def test_is_node_running_is_offloaded_via_asyncio_to_thread_in_every_async_handler():
    # Regression test for a real, previously-unaudited gap: is_node_running()
    # does a blocking socket.connect_ex with up to a 0.5s timeout
    # (src/api.py:59-66), and was called directly -- not through
    # asyncio.to_thread, unlike every other blocking call in this file --
    # inside four async route handlers. This asserts asyncio.to_thread is
    # actually used to invoke it, for each of those four handlers, rather
    # than timing real socket calls (which would be slow and flaky).
    calls = []

    real_to_thread = asyncio.to_thread

    async def spying_to_thread(fn, *args, **kwargs):
        calls.append(fn)
        return await real_to_thread(fn, *args, **kwargs)

    class FakeRequest:
        headers = {}
        method = "GET"

        class url:
            path = "/some/path"
            query = ""

        async def body(self):
            return b""

    async def scenario():
        with patch("asyncio.to_thread", side_effect=spying_to_thread), \
             patch("api.is_node_running", return_value=False):
            # Node reported not running, so each handler takes its
            # fallback path -- this test only cares that is_node_running
            # itself was invoked via asyncio.to_thread before that check,
            # not about the fallback response content.
            await api.health_check(FakeRequest())
            await api.props_check(FakeRequest())
            await api.chat_proxy(FakeRequest())
            try:
                await api.wildcard_api_proxy("some/path", FakeRequest())
            except Exception:
                # wildcard_api_proxy's fallback branch may raise on an
                # unrecognized path in this minimal fake-request harness --
                # irrelevant to this test, which only asserts is_node_running
                # was called through asyncio.to_thread before that point.
                pass

            # Assert while api.is_node_running is still patched: each
            # entry recorded in `calls` is whatever asyncio.to_thread was
            # handed at call time, which is api.is_node_running's *current*
            # value in module globals -- the patched MagicMock, not the
            # real function -- since the four handlers above look it up by
            # bare name at call time. Comparing against api.is_node_running
            # after this `with` block exits (and patch.patch() restores the
            # real function) would make every entry in `calls` fail to
            # match by identity regardless of whether the handlers under
            # test actually route through asyncio.to_thread, so this check
            # must run before that restoration happens.
            assert calls.count(api.is_node_running) == 4, (
                f"expected is_node_running to be invoked via asyncio.to_thread exactly once per "
                f"handler (health_check, props_check, chat_proxy, wildcard_api_proxy), got "
                f"{calls.count(api.is_node_running)} such calls: {calls!r}"
            )

    _run(scenario())
