"""Offline, bounded reading of workspace email exports; message content is untrusted."""
from email import policy
from email.parser import BytesParser
from html.parser import HTMLParser
import json
import mailbox
import os
import re

from attachments import workspace_file

MAX_SCAN = 2000
MAX_MESSAGES = 50
MAX_RESPONSE = 22000


class TextHTML(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.hidden = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "head"):
            self.hidden += 1
        elif not self.hidden and tag in ("p", "div", "br", "li", "tr", "h1", "h2", "h3"):
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style", "head") and self.hidden:
            self.hidden -= 1
        elif not self.hidden and tag in ("p", "div", "li", "tr"):
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def _header(msg, name, maximum=500):
    return str(msg.get(name, ""))[:maximum]


def _text(part):
    data = part.get_payload(decode=True)
    if data is None:
        payload = part.get_payload()
        return payload if isinstance(payload, str) else ""
    try:
        return data.decode(part.get_content_charset() or "utf-8", errors="replace")
    except LookupError:
        return data.decode("utf-8", errors="replace")


def _message(msg, body_limit):
    plain, html, attachments = [], [], []
    for part in msg.walk():
        if part.is_multipart():
            continue
        filename = part.get_filename()
        if part.get_content_disposition() == "attachment" or filename:
            data = part.get_payload(decode=True)
            if len(attachments) < 20:
                attachments.append({"name": (filename or "(unnamed)")[:200], "type": part.get_content_type(),
                                    "size": len(data) if data is not None else 0})
        elif part.get_content_type() == "text/plain":
            plain.append(_text(part))
        elif part.get_content_type() == "text/html":
            html.append(_text(part))
    body = "\n".join(plain).strip()
    if not body and html:
        parser = TextHTML()
        parser.feed("\n".join(html))
        body = re.sub(r"[ \t]+", " ", "".join(parser.parts)).strip()
    headers = [[str(name)[:100], str(value)[:500]] for name, value in list(msg.items())[:30]]
    return {"headers": headers, "headers_truncated": len(msg.items()) > 30 or any(len(str(value)) > 500 for _, value in msg.items()),
            "date": _header(msg, "Date"), "from": _header(msg, "From"), "to": _header(msg, "To"),
            "cc": _header(msg, "Cc"), "subject": _header(msg, "Subject"),
            "message_id": _header(msg, "Message-ID"), "references": _header(msg, "References"),
            "in_reply_to": _header(msg, "In-Reply-To"), "body": body[:body_limit],
            "body_truncated": len(body) > body_limit, "attachments": attachments,
            "attachments_truncated": sum(1 for p in msg.walk() if not p.is_multipart() and (p.get_filename() or p.get_content_disposition() == "attachment")) > 20}


def _subject(msg):
    value = _header(msg, "Subject").strip().casefold()
    return re.sub(r"\s+", " ", re.sub(r"^(?:(?:re|fw|fwd)\s*:\s*)+", "", value)).strip()


def _threads(messages):
    parent = list(range(len(messages)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(a, b):
        a, b = find(a), find(b)
        if a != b:
            parent[max(a, b)] = min(a, b)

    ids, subjects = {}, {}
    for i, msg in enumerate(messages):
        for token in re.findall(r"<[^<>\s]+>", " ".join(_header(msg, n, 4000) for n in ("Message-ID", "References", "In-Reply-To"))):
            token = token.casefold()
            if token in ids:
                union(i, ids[token])
            else:
                ids[token] = i
        subject = _subject(msg)
        if subject:
            if subject in subjects:
                union(i, subjects[subject])
            else:
                subjects[subject] = i
    groups = {}
    for i, msg in enumerate(messages):
        groups.setdefault(find(i), []).append(_message(msg, 1000))
    return [{"messages": group} for group in groups.values()]


def read_email(args):
    path = workspace_file(args.get("path", ""))
    ext = os.path.splitext(path)[1].lower()
    if ext == ".msg":
        raise ValueError("Outlook .msg files are not supported in this build; save or export the message as .eml and read that file instead.")
    if ext == ".eml":
        with open(path, "rb") as source:
            result = _message(BytesParser(policy=policy.default).parse(source), 12000)
        # Keep JSON intact even when unusual headers or filenames are very long.
        while len(json.dumps(result, ensure_ascii=False)) > MAX_RESPONSE:
            if result["body"]:
                result["body"] = result["body"][:len(result["body"]) // 2]
                result["body_truncated"] = True
            elif result["headers"]:
                result["headers"].pop()
                result["headers_truncated"] = True
            else:
                result["attachments"].pop()
                result["attachments_truncated"] = True
        return result
    if ext != ".mbox":
        raise ValueError("read_email supports .eml and .mbox; export Outlook .msg as .eml")
    limit = args.get("limit", 20)
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_MESSAGES:
        raise ValueError(f"limit must be an integer between 1 and {MAX_MESSAGES}")
    sender, folder = args.get("sender", ""), args.get("folder", "")
    if not isinstance(sender, str) or not isinstance(folder, str):
        raise ValueError("sender and folder filters must be strings")
    sender, folder = sender.casefold(), folder.casefold()
    selected, truncated, scanned = [], False, 0
    box = mailbox.mbox(path, factory=lambda f: BytesParser(policy=policy.default).parse(f), create=False)
    try:
        for msg in box:
            scanned += 1
            if scanned > MAX_SCAN:
                truncated = True
                break
            # Standard mbox has no folders; X-Folder is a common export header.
            if sender and sender not in _header(msg, "From").casefold():
                continue
            if folder and folder not in _header(msg, "X-Folder").casefold() and folder not in os.path.basename(path).casefold():
                continue
            if len(selected) == limit:
                truncated = True
                break
            selected.append(msg)
    finally:
        box.close()
    result = {"threads": _threads(selected), "truncated": truncated, "scanned": min(scanned, MAX_SCAN)}
    while len(json.dumps(result, ensure_ascii=False)) > MAX_RESPONSE:
        result["truncated"] = True
        result["threads"][-1]["messages"].pop()
        if not result["threads"][-1]["messages"]:
            result["threads"].pop()
    return result
