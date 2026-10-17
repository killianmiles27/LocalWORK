"""Request-boundary tests: no real HTTP requests or DNS queries."""
from pathlib import Path
import socket
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "workbench-mcp"))
sys.path.insert(0, str(ROOT / "workbench-mcp" / "libs"))
import httpx
import public_web


def address(ip):
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 443))]


class PublicWeb(unittest.TestCase):
    def test_rejects_private_mapped_reserved_and_mixed_dns(self):
        for ip in ("127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "::1", "::ffff:127.0.0.1", "224.0.0.1"):
            with self.subTest(ip=ip), patch.object(public_web.socket, "getaddrinfo", return_value=address(ip)):
                with self.assertRaises(ValueError): public_web.resolve_public("https://target.example")
        with patch.object(public_web.socket, "getaddrinfo", return_value=address("93.184.216.34") + address("10.0.0.1")):
            with self.assertRaises(ValueError): public_web.resolve_public("https://target.example")

    def test_rejects_credentials_local_names_and_non_web_urls(self):
        for url in ("file:///etc/passwd", "http://user:pass@example.com", "http://localhost", "http://foo.local", "http://example.com/\nsecret"):
            with self.subTest(url=url), self.assertRaises(ValueError): public_web.resolve_public(url)

    def client(self, handler):
        real_client = httpx.Client
        return patch.object(httpx, "Client", side_effect=lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs))

    def test_pins_checked_ip_preserving_host_and_tls_identity(self):
        seen = []
        def handler(request):
            seen.append(request)
            return httpx.Response(200, stream=httpx.ByteStream(b"hello"))
        with patch.object(public_web.socket, "getaddrinfo", return_value=address("93.184.216.34")) as dns, self.client(handler) as client:
            result = public_web.fetch_public("https://example.com/report")
            self.assertEqual(dns.call_count, 1)
            self.assertFalse(client.call_args.kwargs["trust_env"])
        self.assertEqual(result.text, "hello")
        self.assertEqual(str(result.request.url), "https://example.com/report")
        self.assertEqual(seen[0].url.host, "93.184.216.34")
        self.assertEqual(seen[0].headers["Host"], "example.com")
        self.assertEqual(seen[0].extensions["sni_hostname"], "example.com")

    def test_redirect_to_private_address_is_blocked_before_connection(self):
        seen = []
        def handler(request):
            seen.append(request)
            return httpx.Response(302, headers={"location": "http://private.example/secret"})
        with patch.object(public_web.socket, "getaddrinfo", side_effect=[address("93.184.216.34"), address("127.0.0.1")]), self.client(handler):
            with self.assertRaises(ValueError): public_web.fetch_public("https://example.com")
        self.assertEqual(len(seen), 1)

    def test_caps_downloads_and_redirects(self):
        with patch.object(public_web.socket, "getaddrinfo", return_value=address("93.184.216.34")):
            with self.client(lambda _: httpx.Response(200, stream=httpx.ByteStream(b"x" * 100))), patch.object(public_web, "MAX_BYTES", 10):
                with self.assertRaisesRegex(ValueError, "download limit"): public_web.fetch_public("https://example.com")
            with self.client(lambda _: httpx.Response(302, headers={"location": "/again"})), patch.object(public_web, "MAX_REDIRECTS", 2):
                with self.assertRaisesRegex(ValueError, "redirects"): public_web.fetch_public("https://example.com")

    def test_redirects_share_one_deadline(self):
        clock = [0]
        def handler(request):
            clock[0] = 46
            return httpx.Response(302, headers={"location": "/slow"})
        with patch.object(public_web.socket, "getaddrinfo", return_value=address("93.184.216.34")), patch.object(public_web.time, "monotonic", side_effect=lambda: clock[0]), self.client(handler):
            with self.assertRaisesRegex(ValueError, "time limit"): public_web.fetch_public("https://example.com")


if __name__ == "__main__": unittest.main()
