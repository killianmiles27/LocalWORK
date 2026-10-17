"""HTTP fetches pinned to a validated public IP, including every redirect."""
import ipaddress
import socket
import time
from urllib.parse import urlsplit, urljoin

MAX_BYTES = 5 * 1024 * 1024
MAX_REDIRECTS = 5


def resolve_public(url):
    if any(ord(c) <= 32 or ord(c) == 127 for c in url):
        raise ValueError("URL contains whitespace or control characters")
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username is not None or parsed.password is not None:
        raise ValueError("Use a public http(s) URL without embedded credentials")
    host = parsed.hostname.rstrip(".").encode("idna").decode("ascii")
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        raise ValueError("Local and private addresses are not allowed")
    try:
        addresses = socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme == "https" else 80), type=socket.SOCK_STREAM)
    except OSError as exc:
        raise ValueError("Could not resolve the requested host") from exc
    if not addresses:
        raise ValueError("Host has no usable address")
    for item in addresses:
        address = ipaddress.ip_address(item[4][0].split("%")[0])
        address = getattr(address, "ipv4_mapped", None) or address
        if not address.is_global or address.is_multicast:
            raise ValueError("Local, private and reserved addresses are not allowed")
    return host, addresses[0][4][0]


def fetch_public(url):
    import httpx
    deadline = time.monotonic() + 45
    for redirect in range(MAX_REDIRECTS + 1):
        if time.monotonic() >= deadline:
            raise ValueError("Page exceeded the fetch time limit")
        host, address = resolve_public(url)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ValueError("Page exceeded the fetch time limit")
        original = httpx.URL(url)
        target = original.copy_with(host=address, fragment=None)
        headers = {"Host": original.netloc.decode("ascii"), "Accept-Encoding": "identity",
                   "User-Agent": "Mozilla/5.0 (LocalWORK research assistant)"}
        # Connect to the checked IP instead of resolving the hostname again. The
        # original name remains the TLS certificate/SNI identity and Host header.
        with httpx.Client(trust_env=False, follow_redirects=False, timeout=min(25, remaining)) as client:
            with client.stream("GET", target, headers=headers, extensions={"sni_hostname": host}) as response:
                if response.status_code in (301, 302, 303, 307, 308):
                    if redirect == MAX_REDIRECTS or not response.headers.get("location"):
                        raise ValueError("Too many redirects or missing redirect destination")
                    url = urljoin(url, response.headers["location"])
                    continue
                response.raise_for_status()
                if response.headers.get("content-encoding", "identity").lower() not in ("", "identity"):
                    raise ValueError("Compressed response ignored the requested identity encoding")
                if int(response.headers.get("content-length", "0")) > MAX_BYTES:
                    raise ValueError("Page exceeds the 5 MiB download limit")
                body = bytearray()
                for chunk in response.iter_raw():
                    if len(body) + len(chunk) > MAX_BYTES:
                        raise ValueError("Page exceeds the 5 MiB download limit")
                    if time.monotonic() > deadline:
                        raise ValueError("Page exceeded the fetch time limit")
                    body.extend(chunk)
                return httpx.Response(response.status_code, headers=response.headers, content=bytes(body), request=httpx.Request("GET", url))
    raise ValueError("Too many redirects")
