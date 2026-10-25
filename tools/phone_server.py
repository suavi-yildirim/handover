#!/usr/bin/env python3
"""Local server for Handover with phone control.

Serves the project folder as static files and relays control messages
between the phone controller page and the game page over WebSockets.

  http://localhost:8000/          the game, on the Mac
  https://<mac-ip>:8443/phone/    the controller, on a phone on the same Wi-Fi

The phone page needs HTTPS because iPhone Safari (and recent Android Chrome)
only expose tilt sensors to secure pages. A self-signed certificate is made
on first run in .certs/; the phone shows a warning once, tap through it.

Standard library only, Python 3.9+ (the python3 that ships with macOS).

  python3 tools/phone_server.py [--port 8000] [--https-port 8443] [--root .]
"""

import argparse
import base64
import functools
import hashlib
import http.server
import ipaddress
import json
import os
import socket
import ssl
import struct
import subprocess
import sys
import threading
import time

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
ROLES = ("game", "phone")


def lan_ip():
    """Best guess at this machine's address on the home network."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # No packet is sent; this only picks the outgoing interface.
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def ensure_cert(cert_dir, ip):
    """Make a self-signed cert for localhost and the LAN IP, if missing or stale."""
    os.makedirs(cert_dir, exist_ok=True)
    cert = os.path.join(cert_dir, "cert.pem")
    key = os.path.join(cert_dir, "key.pem")
    stamp = os.path.join(cert_dir, "ip.txt")
    if os.path.exists(cert) and os.path.exists(key) and os.path.exists(stamp):
        with open(stamp) as f:
            if f.read().strip() == ip:
                return cert, key
    san = "DNS:localhost,IP:127.0.0.1"
    if ip != "127.0.0.1":
        san += ",IP:" + ip
    cmd = [
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", key, "-out", cert, "-days", "825",
        "-subj", "/CN=Handover local",
        "-addext", "subjectAltName=" + san,
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True)
    except (OSError, subprocess.CalledProcessError) as e:
        err = getattr(e, "stderr", b"") or b""
        print("Could not create a certificate with openssl: %s %s" % (e, err.decode(errors="replace")))
        return None, None
    with open(stamp, "w") as f:
        f.write(ip)
    return cert, key


class Hub:
    """Tracks connected clients and forwards messages from one role to the other."""

    def __init__(self):
        self.lock = threading.Lock()
        self.clients = {role: set() for role in ROLES}

    def add(self, conn):
        with self.lock:
            self.clients[conn.role].add(conn)
        self.announce()

    def remove(self, conn):
        with self.lock:
            self.clients[conn.role].discard(conn)
        self.announce()

    def counts(self):
        with self.lock:
            return {role: len(c) for role, c in self.clients.items()}

    def forward(self, sender, text):
        other = "phone" if sender.role == "game" else "game"
        with self.lock:
            targets = list(self.clients[other])
        for conn in targets:
            conn.send_text(text)

    def announce(self):
        msg = json.dumps({"t": "peers", **self.counts()})
        with self.lock:
            targets = [c for cs in self.clients.values() for c in cs]
        for conn in targets:
            conn.send_text(msg)


class WSConn:
    """Minimal RFC 6455 server side: text frames, ping/pong, close."""

    def __init__(self, rfile, wfile, role):
        self.rfile = rfile
        self.wfile = wfile
        self.role = role
        self.wlock = threading.Lock()
        self.closed = False

    def _send(self, opcode, payload):
        header = bytes([0x80 | opcode])
        n = len(payload)
        if n < 126:
            header += bytes([n])
        elif n < 65536:
            header += bytes([126]) + struct.pack("!H", n)
        else:
            header += bytes([127]) + struct.pack("!Q", n)
        with self.wlock:
            if self.closed:
                return
            try:
                self.wfile.write(header + payload)
                self.wfile.flush()
            except OSError:
                self.closed = True

    def send_text(self, text):
        self._send(0x1, text.encode())

    def _read_exact(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.rfile.read(n - len(buf))
            if not chunk:
                raise ConnectionError("socket closed")
            buf += chunk
        return buf

    def messages(self):
        """Yield decoded text messages until the client goes away."""
        fragments = []
        while not self.closed:
            b0, b1 = self._read_exact(2)
            fin, opcode = b0 & 0x80, b0 & 0x0F
            n = b1 & 0x7F
            if n == 126:
                n = struct.unpack("!H", self._read_exact(2))[0]
            elif n == 127:
                n = struct.unpack("!Q", self._read_exact(8))[0]
            if n > 1 << 20:
                raise ConnectionError("frame too large")
            mask = self._read_exact(4) if b1 & 0x80 else None
            data = self._read_exact(n)
            if mask:
                data = bytes(c ^ mask[i % 4] for i, c in enumerate(data))
            if opcode == 0x8:
                self._send(0x8, data[:2])
                return
            if opcode == 0x9:
                self._send(0xA, data)
                continue
            if opcode == 0xA:
                continue
            fragments.append(data)
            if fin:
                msg = b"".join(fragments)
                fragments = []
                yield msg.decode(errors="replace")


class Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"  # browsers require it for the WebSocket upgrade
    hub = None
    info = None
    log_dir = None

    def do_POST(self):
        # The phone's axes page sends calibration and sensor diagnostics here; they
        # are saved next to the project so they can be inspected later.
        if self.path.split("?", 1)[0] != "/__phone/log":
            self.send_error(404)
            return
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > 256 * 1024:
            self.send_error(413)
            return
        body = self.rfile.read(n)
        try:
            record = json.loads(body)
        except ValueError:
            self.send_error(400)
            return
        os.makedirs(self.log_dir, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        kind = "".join(c for c in str(record.get("kind", "log")) if c.isalnum() or c in "-_")[:32] or "log"
        path = os.path.join(self.log_dir, "%s-%s.json" % (stamp, kind))
        with open(path, "w") as f:
            json.dump(record, f, indent=1)
        print("Phone %s saved to %s" % (kind, os.path.relpath(path)))
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, fmt, *args):
        # Static file requests are noise; keep errors only.
        if args and str(args[1])[:1] in "45":
            super().log_message(fmt, *args)

    def end_headers(self):
        # Always fetch fresh code while developing.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/ws":
            return self.handle_ws()
        if path == "/__phone/info":
            body = json.dumps({**self.info, **self.hub.counts()}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def handle_ws(self):
        query = self.path.split("?", 1)[1] if "?" in self.path else ""
        params = dict(p.split("=", 1) for p in query.split("&") if "=" in p)
        role = params.get("role")
        key = self.headers.get("Sec-WebSocket-Key")
        if role not in ROLES or not key or "websocket" not in self.headers.get("Upgrade", "").lower():
            self.send_error(400, "Expected a WebSocket upgrade with ?role=game or ?role=phone")
            return
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        super().end_headers()  # skip the Cache-Control header
        self.wfile.flush()
        # Small control messages: send them now, don't batch.
        self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)

        conn = WSConn(self.rfile, self.wfile, role)
        self.hub.add(conn)
        try:
            for text in conn.messages():
                self.hub.forward(conn, text)
        except (ConnectionError, OSError, ValueError):
            pass
        finally:
            conn.closed = True
            self.hub.remove(conn)
            self.close_connection = True


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, client_address):
        # A phone that hasn't accepted the certificate yet just drops the
        # connection; don't print a traceback for that.
        if isinstance(sys.exc_info()[1], (ssl.SSLError, ConnectionError)):
            return
        super().handle_error(request, client_address)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web"),
                    help="folder to serve (default: web/)")
    ap.add_argument("--port", type=int, default=8000, help="HTTP port for the Mac (default 8000)")
    ap.add_argument("--https-port", type=int, default=8443, help="HTTPS port for the phone (default 8443)")
    ap.add_argument("--host", default="0.0.0.0", help="address to listen on (default: all)")
    args = ap.parse_args()

    root = os.path.abspath(args.root)
    ip = lan_ip()
    project = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
    cert, key = ensure_cert(os.path.join(project, ".certs"), ip)

    phone_url = "https://%s:%d/phone/" % (ip, args.https_port) if cert else "http://%s:%d/phone/" % (ip, args.port)
    Handler.hub = Hub()
    Handler.log_dir = os.path.join(project, ".phone_logs")
    Handler.info = {"phone_url": phone_url, "lan_ip": ip, "https": bool(cert)}
    handler = functools.partial(Handler, directory=root)

    servers = [Server((args.host, args.port), handler)]
    if cert:
        https = Server((args.host, args.https_port), handler)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert, key)
        # Handshake in the request thread, so one slow phone can't block accept().
        https.socket = ctx.wrap_socket(https.socket, server_side=True, do_handshake_on_connect=False)
        servers.append(https)
    for s in servers[1:]:
        threading.Thread(target=s.serve_forever, daemon=True).start()

    print("Handover server, serving %s" % root)
    print("  On this Mac:    http://localhost:%d/" % args.port)
    print("  On your phone:  %s" % phone_url)
    if cert:
        print("                  (first time: the phone warns about the certificate; tap")
        print("                   'Show Details' > 'visit this website' or 'Advanced' > 'Proceed')")
    else:
        print("  No HTTPS: tilt will not work on iPhone. Install openssl and restart.")
    if ipaddress.ip_address(ip).is_loopback:
        print("  Could not find a Wi-Fi address; is the Mac on a network?")
    print("Ctrl+C to stop.")
    try:
        servers[0].serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    sys.exit(main())
