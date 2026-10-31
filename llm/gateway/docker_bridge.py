"""Проброс шлюза с loopback на docker0.

Контейнер backend не видит 127.0.0.1 хоста. Шлюз остаётся на loopback,
а этот процесс слушает только адрес docker0.
"""

import fcntl
import socket
import struct
import sys
import threading

TARGET = ("127.0.0.1", 4000)


def docker0_address() -> str:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        info = fcntl.ioctl(sock.fileno(), 0x8915, struct.pack("256s", b"docker0"))
    finally:
        sock.close()
    return socket.inet_ntoa(info[20:24])


def _pipe(source: socket.socket, dest: socket.socket) -> None:
    try:
        while True:
            data = source.recv(65536)
            if not data:
                break
            dest.sendall(data)
    except OSError:
        pass
    finally:
        for item in (source, dest):
            try:
                item.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def _handle(client: socket.socket) -> None:
    try:
        remote = socket.create_connection(TARGET, timeout=10)
        remote.settimeout(None)
    except OSError:
        client.close()
        return
    threading.Thread(target=_pipe, args=(client, remote), daemon=True).start()
    _pipe(remote, client)
    client.close()
    remote.close()


def main() -> None:
    host = docker0_address()
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((host, 4000))
    server.listen(64)
    while True:
        client, _ = server.accept()
        threading.Thread(target=_handle, args=(client,), daemon=True).start()


def healthcheck() -> int:
    try:
        host = docker0_address()
        conn = socket.create_connection((host, TARGET[1]), timeout=5)
        conn.close()
    except OSError:
        return 1
    return 0


if __name__ == "__main__":
    if sys.argv[1:] == ["--health"]:
        raise SystemExit(healthcheck())
    main()
