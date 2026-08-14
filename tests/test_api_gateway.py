"""
Regression coverage for src/api.py's async route handlers not blocking the
event loop, plus a pentest-caught gateway auth-bypass fix (see
test_make_proxy_request_passes_through_the_callers_own_api_key_unchanged
below). Plain asyncio.run()-driven tests, matching daemon/tests/
test_voice_engine.py's convention (no pytest-asyncio dependency) rather than
using anyio/pytest-asyncio markers, to keep this project's two Python test
suites consistent.
"""
import asyncio
import os
import sys
import urllib.error
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


def test_make_proxy_request_passes_through_the_callers_own_api_key_unchanged():
    # Penetration-test-caught regression: make_proxy_request/
    # proxy_streaming_request used to unconditionally overwrite the
    # proxied request's x-api-key header with INTERNAL_API_KEY, regardless
    # of what the original caller actually sent -- meaning every request
    # through this gateway (unauthenticated, wrong key, or a real non-admin
    # user's own key) reached Express as full admin. Live-verified via a
    # real gateway+Express pair: an unauthenticated GET through the gateway
    # returned admin-level data that the same request sent directly to
    # Express correctly 401'd. Fixed by no longer stamping x-api-key at
    # all -- the caller's own header (or its absence) must now reach
    # Express unchanged, letting Express's own validateApiKey decide.
    captured_requests = []

    def fake_urlopen(req, timeout=None):
        captured_requests.append(req)
        # Short-circuits make_proxy_request's own try/except (it re-raises
        # URLError to trigger the caller's fallback path) -- this test only
        # needs the Request object urlopen was handed, not a real response.
        raise urllib.error.URLError("test: not actually connecting anywhere")

    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        # Case 1: caller sent their own (non-admin) key -- must reach
        # Express as-is, not silently upgraded to INTERNAL_API_KEY.
        try:
            api.make_proxy_request("/api/whoami", "GET", {"x-api-key": "some-non-admin-users-own-key"})
        except urllib.error.URLError:
            pass
        assert len(captured_requests) == 1
        forwarded_key = captured_requests[0].get_header("X-api-key")
        assert forwarded_key == "some-non-admin-users-own-key", (
            f"expected the caller's own x-api-key to reach Express unchanged, "
            f"got {forwarded_key!r} (INTERNAL_API_KEY is {api.INTERNAL_API_KEY!r})"
        )
        assert forwarded_key != api.INTERNAL_API_KEY

        # Case 2: caller sent no key at all -- must reach Express with no
        # key either (so Express's own validateApiKey correctly 401s it),
        # not silently granted the admin key.
        captured_requests.clear()
        try:
            api.make_proxy_request("/api/whoami", "GET", {})
        except urllib.error.URLError:
            pass
        assert len(captured_requests) == 1
        assert captured_requests[0].get_header("X-api-key") is None, (
            f"expected no x-api-key on a request whose caller sent none, "
            f"got {captured_requests[0].get_header('X-api-key')!r}"
        )


def test_proxy_streaming_request_passes_through_the_callers_own_api_key_unchanged():
    # Same bug, same fix, as the make_proxy_request test above, but for the
    # /api/chat streaming path -- proxy_streaming_request had an identical
    # unconditional x-api-key overwrite and is a separate function, so a
    # regression here would slip past a fix/test that only covers
    # make_proxy_request.
    captured_requests = []

    def fake_urlopen(req, timeout=None):
        captured_requests.append(req)
        raise urllib.error.URLError("test: not actually connecting anywhere")

    async def scenario():
        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            # proxy_streaming_request catches URLError internally and
            # re-raises it as a FastAPI HTTPException (503) -- this test
            # only needs the Request object urlopen was handed before that
            # happens, so any exception here is expected and irrelevant.
            try:
                await api.proxy_streaming_request("/api/chat", "POST", {"x-api-key": "some-non-admin-users-own-key"}, b"{}")
            except Exception:
                pass
            assert len(captured_requests) == 1
            forwarded_key = captured_requests[0].get_header("X-api-key")
            assert forwarded_key == "some-non-admin-users-own-key", (
                f"expected the caller's own x-api-key to reach Express unchanged, "
                f"got {forwarded_key!r} (INTERNAL_API_KEY is {api.INTERNAL_API_KEY!r})"
            )
            assert forwarded_key != api.INTERNAL_API_KEY

            captured_requests.clear()
            try:
                await api.proxy_streaming_request("/api/chat", "POST", {}, b"{}")
            except Exception:
                pass
            assert len(captured_requests) == 1
            assert captured_requests[0].get_header("X-api-key") is None, (
                f"expected no x-api-key on a request whose caller sent none, "
                f"got {captured_requests[0].get_header('X-api-key')!r}"
            )

    _run(scenario())
