#!/usr/bin/env python3
"""
Shared JMAP client used by jmap-aux-sync.py and jmap-aux-restore.py.

Lifted from legacy/jmap-sync.py and trimmed to the surface the aux
scripts need: keep-alive HTTP, redirect following, jmap:error:limit
retry, basic auth. No Email/* / Blob/* helpers — those live in the
mail scripts.

Auth model: master-user proxy. The username is `<addr>%<master_fq>`
(percent-separated; Stalwart's master-auth shape) and the password is
the master principal's secret. See bootstrap.sh's
`provision_stalwart_master_user` for how the master principal is
created.
"""
from __future__ import annotations

import base64
import http.client
import json
import random
import socket
import ssl
import sys
import threading
import time
from typing import Any, Optional
from urllib.parse import urlsplit


JMAP_URN_CORE = "urn:ietf:params:jmap:core"


class JmapError(Exception):
    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code
        self.detail = detail


class JmapAuxClient:
    """Thread-safe JMAP client. Each call shares the same auth header;
    HTTP connections are thread-local so concurrent /get + /set don't
    race on the same socket. The aux scripts are mostly single-threaded
    though — concurrency is an upstream extension, not a v1 requirement.
    """

    def __init__(self, endpoint: str, basic_auth_user: str, basic_auth_pass: str) -> None:
        if not endpoint.endswith("/.well-known/jmap") and "/api" not in endpoint:
            endpoint = endpoint.rstrip("/") + "/.well-known/jmap"
        self.session_url = endpoint
        raw = f"{basic_auth_user}:{basic_auth_pass}".encode()
        self._auth_header = "Basic " + base64.b64encode(raw).decode()
        self._api_url: Optional[str] = None
        self._upload_url: Optional[str] = None
        self._download_url: Optional[str] = None
        self._primary_accounts: dict[str, str] = {}
        self._tls_context = ssl.create_default_context()
        self._tls = threading.local()

    # ── HTTP layer ─────────────────────────────────────────────────────────

    def _get_conn(self, netloc: str, is_https: bool) -> http.client.HTTPConnection:
        existing = getattr(self._tls, "conn", None)
        if existing is not None and getattr(self._tls, "netloc", "") == netloc:
            return existing
        if existing is not None:
            try:
                existing.close()
            except Exception:
                pass
        if is_https:
            conn: http.client.HTTPConnection = http.client.HTTPSConnection(
                netloc, timeout=60, context=self._tls_context)
        else:
            conn = http.client.HTTPConnection(netloc, timeout=60)
        self._tls.conn = conn
        self._tls.netloc = netloc
        return conn

    def _http(self, url: str, *, method: str = "GET", body: Optional[bytes] = None,
              accept: str = "application/json",
              content_type: Optional[str] = None) -> tuple[int, bytes, str]:
        u = urlsplit(url)
        is_https = u.scheme == "https"
        netloc = u.netloc
        path = u.path or "/"
        if u.query:
            path = f"{path}?{u.query}"
        headers = {
            "Authorization": self._auth_header,
            "Accept": accept,
            "Connection": "keep-alive",
        }
        if body is not None:
            headers["Content-Type"] = content_type or "application/json; charset=utf-8"
            headers["Content-Length"] = str(len(body))

        attempts = 0
        redirects = 0
        while True:
            conn = self._get_conn(netloc, is_https)
            try:
                conn.request(method, path, body=body, headers=headers)
                resp = conn.getresponse()
                status = resp.status
                location = resp.getheader("Location") or ""
                data = resp.read()
                ctype = resp.getheader("Content-Type", "") or ""
                if status in (301, 302, 307, 308) and location and redirects < 3:
                    if location.startswith("/"):
                        path = location
                    else:
                        lu = urlsplit(location)
                        if lu.netloc and lu.netloc != netloc:
                            netloc = lu.netloc
                            is_https = lu.scheme == "https"
                        path = lu.path + (f"?{lu.query}" if lu.query else "")
                    redirects += 1
                    continue
                # Mirror the legacy `jmap:error:limit` retry: Stalwart applies
                # a per-method-call rate limit. Exponential backoff with
                # jitter up to 8 attempts; cap of 2 s per attempt keeps the
                # aux backup well under its overall Job timeout.
                if status == 400 and b"jmap:error:limit" in data and attempts < 8:
                    base = min(0.1 * (2 ** attempts), 2.0)
                    delay = base * (0.5 + random.random())
                    time.sleep(delay)
                    attempts += 1
                    continue
                return status, data, ctype
            except (http.client.HTTPException, OSError, socket.error) as e:
                try:
                    conn.close()
                except Exception:
                    pass
                self._tls.conn = None
                if attempts >= 3:
                    raise JmapError("network", f"{type(e).__name__}: {e}")
                time.sleep(0.5 * (attempts + 1))
                attempts += 1

    # ── Session bootstrap ──────────────────────────────────────────────────

    def session(self) -> dict[str, Any]:
        status, data, _ = self._http(self.session_url, method="GET")
        if status != 200:
            raise JmapError("session", f"HTTP {status}: {data[:200].decode(errors='replace')}")
        sess = json.loads(data)
        # Stalwart's session response advertises apiUrl/uploadUrl/downloadUrl
        # rooted at its public HTTPS hostname (the operator-configured mail
        # FQDN). For in-cluster JMAP calls we want to keep going through the
        # input endpoint (typically http://stalwart-mgmt.mail.svc:8080) —
        # otherwise we chase TLS that the helper pod's CA bundle can't
        # validate. Rebase the path component onto the endpoint host.
        endpoint_base = self.session_url.rsplit("/.well-known/jmap", 1)[0] \
            if "/.well-known/jmap" in self.session_url else self.session_url
        endpoint_base = endpoint_base.rstrip("/")
        self._api_url = _rebase_url(sess.get("apiUrl"), endpoint_base)
        self._upload_url = _rebase_url(sess.get("uploadUrl"), endpoint_base)
        self._download_url = _rebase_url(sess.get("downloadUrl"), endpoint_base)
        self._primary_accounts = sess.get("primaryAccounts", {}) or {}
        if not self._api_url:
            raise JmapError("session", "no apiUrl in session response")
        return sess

    def primary_account_id(self, capability_uri: str) -> str:
        if not self._primary_accounts:
            self.session()
        acct = self._primary_accounts.get(capability_uri)
        if not acct:
            raise JmapError(
                "no-account",
                f"capability {capability_uri} not in primaryAccounts (account may not have this surface enabled)",
            )
        return acct

    # ── JMAP call helpers ──────────────────────────────────────────────────

    def call(self, using: list[str], method_calls: list[list[Any]]) -> list[list[Any]]:
        """POST a JMAP request, return the methodResponses array."""
        if not self._api_url:
            self.session()
        body = json.dumps({"using": using, "methodCalls": method_calls}).encode()
        status, data, _ = self._http(self._api_url, method="POST", body=body)  # type: ignore[arg-type]
        if status != 200:
            raise JmapError("http", f"HTTP {status}: {data[:300].decode(errors='replace')}")
        resp = json.loads(data)
        return resp.get("methodResponses", [])

    def call_one(self, using: list[str], method: str, args: dict[str, Any]) -> dict[str, Any]:
        """POST a single methodCall, return the args of the first response.
        Raises JmapError if the response is `error`."""
        responses = self.call(using, [[method, args, "c0"]])
        if not responses:
            raise JmapError("empty-response", f"no methodResponses for {method}")
        first_method, first_args, _ = responses[0]
        if first_method == "error":
            raise JmapError(
                "method-error",
                f"{method} returned error: {first_args.get('type')} "
                f"{first_args.get('description', '')[:120]}",
            )
        if first_method != method:
            raise JmapError(
                "unexpected-method",
                f"expected {method}, got {first_method}",
            )
        return first_args

    # ── Blob helpers (for SieveScript bodies) ──────────────────────────────

    def blob_download(self, account_id: str, blob_id: str) -> bytes:
        if not self._download_url:
            self.session()
        url = (self._download_url or "")  # type: ignore[arg-type]
        url = (url
               .replace("{accountId}", account_id)
               .replace("{blobId}", blob_id)
               .replace("{type}", "application/octet-stream")
               .replace("{name}", "blob"))
        status, data, _ = self._http(url, method="GET", accept="*/*")
        if status != 200:
            raise JmapError("blob-download", f"HTTP {status} for {blob_id}: {data[:200].decode(errors='replace')}")
        return data

    def blob_upload(self, account_id: str, body: bytes,
                    content_type: str = "application/sieve") -> str:
        """Upload a blob, return blobId. Used by SieveScript restore to
        upload the script body before SieveScript/set patches the id."""
        if not self._upload_url:
            self.session()
        url = (self._upload_url or "").replace("{accountId}", account_id)  # type: ignore[arg-type]
        status, data, _ = self._http(
            url, method="POST", body=body,
            accept="application/json", content_type=content_type,
        )
        if status not in (200, 201):
            raise JmapError("blob-upload", f"HTTP {status}: {data[:200].decode(errors='replace')}")
        resp = json.loads(data)
        blob_id = resp.get("blobId")
        if not blob_id:
            raise JmapError("blob-upload", f"no blobId in upload response: {resp}")
        return blob_id


def make_client(endpoint: str, account_address: str, master_user: str,
                password: str) -> JmapAuxClient:
    """Standard master-user-proxy auth: `<addr>%<master_fq>`."""
    user = f"{account_address}%{master_user}"
    return JmapAuxClient(endpoint, user, password)


def read_password_env(env_var_name: str) -> str:
    import os
    pw = os.environ.get(env_var_name, "").strip()
    if not pw:
        print(f"FATAL: env {env_var_name} is empty", file=sys.stderr)
        sys.exit(2)
    return pw


def _rebase_url(url: Optional[str], new_base: str) -> Optional[str]:
    """Stalwart's session.{api,upload,download}Url point at the public
    HTTPS hostname. For in-cluster calls we want to keep going through
    the input endpoint (HTTP, no cert). Rebase keeps the path + any
    template variables intact.
    """
    if not url:
        return None
    u = urlsplit(url)
    path_q = u.path + (f"?{u.query}" if u.query else "")
    return new_base + path_q
