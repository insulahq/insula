#!/usr/bin/env python3
"""oauth-probe.py — what an OAuth sign-in means for the platform's login passwords (ADR-049,
ADR-065). Against a v1 server set up by loadgen.py setup-configure:

  1. issue a login password (x:AppPassword) for u000, as the platform does
  2. register a public OAuth client (RFC 7591), authorization code + PKCE
  3. sign in on the server's sign-in API with the mailbox address + that login password
  4. use the token: JMAP (Bearer) and IMAP (XOAUTH2)
  5. revoke the login password → does the token still work? does the refresh still work?
  6. revoke the OAuth grant (x:OAuthGrant, "connected applications") → and now?

Prints one JSON document with every step's outcome. Environment as loadgen.py.
"""
import base64
import hashlib
import imaplib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import loadgen as lg  # noqa: E402

BASE = f"http://{lg.HOST}:{lg.JMAP_PORT}"


def http(method, path, body=None, headers=None, form=False):
    data = None
    hdrs = dict(headers or {})
    if body is not None:
        if form:
            data = urllib.parse.urlencode(body).encode()
            hdrs["Content-Type"] = "application/x-www-form-urlencoded"
        else:
            data = json.dumps(body).encode()
            hdrs["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=hdrs)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, raw[:300].decode(errors="replace")


def bearer_session(token):
    return http("GET", "/jmap/session", headers={"Authorization": f"Bearer {token}"})[0]


def imap_xoauth2(user, token):
    m = imaplib.IMAP4(lg.HOST, 143, timeout=30)
    try:
        if "STARTTLS" in m.capabilities:
            m.starttls(ssl_context=lg.TLS)
        caps = [c for c in m.capabilities if c.startswith("AUTH=")]
        auth = f"user={user}\x01auth=Bearer {token}\x01\x01".encode()
        typ, _ = m.authenticate("XOAUTH2", lambda _: auth)
        return {"result": typ, "mechanisms": caps}
    except imaplib.IMAP4.error as e:
        return {"result": "NO", "error": str(e)[:160]}
    finally:
        try:
            m.logout()
        except Exception:  # noqa: BLE001
            pass


def refresh(client_id, refresh_token):
    code, r = http("POST", "/auth/token", {"grant_type": "refresh_token", "refresh_token": refresh_token,
                                           "client_id": client_id}, form=True)
    return code, r


def main():
    out = {}
    try:
        probe(out)
    except Exception as exc:  # noqa: BLE001 — report how far it got
        out["stopped"] = f"{type(exc).__name__}: {exc}"
    json.dump(out, sys.stdout, indent=1, default=str)
    print()


def probe(out):
    user = lg.address("u000")
    adm = lg.admin()
    acc = next(a for a in lg.admin_call(adm, "x:Account/get", {"ids": None, "properties": ["id", "name"]})["list"]
               if a["name"] == "u000")
    aid = acc["id"]
    prov = lg.admin_call(adm, "x:OidcProvider/get", {"ids": ["singleton"]})["list"][0]
    out["0_token_lifetimes_ms"] = {k: prov.get(k) for k in ("accessTokenExpiry", "refreshTokenExpiry",
                                                            "authCodeExpiry", "idTokenExpiry")}

    # 1. login password, created the way login-passwords/service.ts does it
    r = adm._req("POST", "/jmap/", json.dumps({"using": list(lg.ADMIN_USING), "methodCalls": [[
        "x:AppPassword/set", {"accountId": aid, "create": {"p": {"description": "oauth probe",
                                                                  "allowedIps": {}, "expiresAt": None}}}, "c0"]]}))
    created = r["methodResponses"][0][1]["created"]["p"]
    app_id, app_secret = created["id"], created["secret"]
    out["1_login_password"] = {"id": app_id, "basic_auth_jmap":
                               http("GET", "/jmap/session", headers={"Authorization": "Basic " + base64.b64encode(
                                   f"{user}:{app_secret}".encode()).decode()})[0]}

    # 2. a public client, as a desktop mail client registers itself (RFC 7591; dynamically
    #    registered clients may not use the device-code grant, so authorization code + PKCE)
    code, reg = http("POST", "/auth/register", {
        "client_name": "ADR-065 probe", "redirect_uris": ["http://127.0.0.1/cb"], "token_endpoint_auth_method": "none",
        "grant_types": ["authorization_code", "refresh_token"],
        "scope": "openid offline_access urn:ietf:params:oauth:scope:mail"})
    out["2_register"] = {"status": code, "response": reg}
    client_id = reg["client_id"]
    verifier = base64.urlsafe_b64encode(os.urandom(32)).rstrip(b"=").decode()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    query = urllib.parse.urlencode({"response_type": "code", "client_id": client_id,
                                    "redirect_uri": "http://127.0.0.1/cb", "state": "probe",
                                    "code_challenge": challenge, "code_challenge_method": "S256",
                                    "scope": "openid offline_access urn:ietf:params:oauth:scope:mail"})

    # 3. sign in with the mailbox address and the LOGIN PASSWORD (nobody knows the primary)
    code, appr = http("POST", "/api/auth", {"type": "authCode", "accountName": user, "accountSecret": app_secret,
                                             "query": query, "consent": True})
    out["3_sign_in_with_login_password"] = {"status": code, "response": appr}
    location = appr["location"]
    auth_code = urllib.parse.parse_qs(urllib.parse.urlparse(location).query)["code"][0]
    code, tok = http("POST", "/auth/token", {"grant_type": "authorization_code", "code": auth_code,
                                             "redirect_uri": "http://127.0.0.1/cb", "client_id": client_id,
                                             "code_verifier": verifier}, form=True)
    out["3_token"] = {"status": code, "keys": sorted(tok) if isinstance(tok, dict) else tok,
                      "expires_in": (tok or {}).get("expires_in") if isinstance(tok, dict) else None,
                      "scope": (tok or {}).get("scope") if isinstance(tok, dict) else None}
    access, refresh_token = tok["access_token"], tok.get("refresh_token")

    # 4. use it
    out["4_jmap_bearer"] = bearer_session(access)
    out["4_imap_xoauth2"] = imap_xoauth2(user, access)

    # 5. revoke the login password
    lg.admin_call(adm, "x:AppPassword/set", {"accountId": aid, "destroy": [app_id]})
    time.sleep(2)
    out["5_after_login_password_revoked"] = {
        "basic_auth_with_it": http("GET", "/jmap/session", headers={"Authorization": "Basic " + base64.b64encode(
            f"{user}:{app_secret}".encode()).decode()})[0],
        "jmap_bearer": bearer_session(access),
        "imap_xoauth2": imap_xoauth2(user, access)["result"],
    }
    code, rt = refresh(client_id, refresh_token)
    out["5_after_login_password_revoked"]["refresh"] = code
    if code == 200:
        access, refresh_token = rt["access_token"], rt.get("refresh_token", refresh_token)
        out["5_after_login_password_revoked"]["jmap_with_refreshed"] = bearer_session(access)

    # 6. the grant itself
    grants = lg.admin_call(adm, "x:OAuthGrant/get", {"accountId": aid, "ids": None})["list"]
    out["6_grants_listed"] = [{k: g.get(k) for k in ("id", "clientName", "clientKind", "scopes", "remoteIp")}
                              for g in grants]
    if grants:
        lg.admin_call(adm, "x:OAuthGrant/set", {"accountId": aid, "destroy": [g["id"] for g in grants]})
        time.sleep(2)
        out["6_after_grant_revoked"] = {"jmap_bearer": bearer_session(access), "refresh": refresh(client_id,
                                                                                                    refresh_token)[0]}


if __name__ == "__main__":
    main()
