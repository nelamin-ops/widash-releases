import time
from backend.cache import TtlCache


def test_cache_returns_value_within_ttl():
    c = TtlCache(ttl_seconds=10)
    c.set("k", "v")
    assert c.get("k") == "v"


def test_cache_expires_after_ttl():
    c = TtlCache(ttl_seconds=0.05)
    c.set("k", "v")
    time.sleep(0.1)
    assert c.get("k") is None


def test_cache_clear():
    c = TtlCache(ttl_seconds=10)
    c.set("k", "v")
    c.clear()
    assert c.get("k") is None


def test_cache_separate_keys():
    c = TtlCache(ttl_seconds=10)
    c.set("a", 1)
    c.set("b", 2)
    assert c.get("a") == 1
    assert c.get("b") == 2
