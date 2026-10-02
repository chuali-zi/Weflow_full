"""Bounded, read-only WCDB key discovery. Reader is injectable for Linux tests.

Layout facts are isolated here; successful page authentication, not a signature
match, is the acceptance condition. See docs/wxtext-architecture.md for provenance.
"""
from dataclasses import dataclass, field
import re
import struct
import time

from .cipher import derive_key, verify_key


@dataclass(frozen=True)
class ConfigLayout:
    label: str = "wcdb-config-cipher-v1"
    marker: bytes = b"com.Tencent.WCDB.Config.Cipher"
    reference_to_config: int = 0x18
    config_to_buffer: int = 0x90
    mask: bytes = field(default=bytes.fromhex(
        "d2c7442458020000004889442450488b450048844c2448488944254048584c24"), repr=False)


LAYOUT = ConfigLayout()
LITERAL = re.compile(rb"[xX]'([0-9a-fA-F]{96}|[0-9a-fA-F]{64})'")
CHUNK_SIZE = 1024 * 1024


def memory_chunks(reader, deadline: float, regions=None):
    for base, size in (reader.regions() if regions is None else regions):
        offset, tail = 0, b""
        while offset < size:
            if time.monotonic() >= deadline:
                return
            requested = min(CHUNK_SIZE, size - offset)
            data = reader.read(base + offset, requested)
            if data:
                yield base + offset - len(tail), tail + data
                tail = data[-256:] if len(data) == requested else b""
            else:
                tail = b""
            offset += requested


class KeyMatcher:
    def __init__(self, headers: dict[str, bytes], existing=None, required=None):
        self.headers = headers
        self.required = set(headers if required is None else required)
        self.keys = dict(existing or {})
        self.tested = set()
        self.candidates = 0

    @property
    def complete(self):
        return self.required <= self.keys.keys()

    def consider(self, material: bytes, salt: bytes | None = None, kind: str = "raw",
                 deadline: float = float("inf")):
        identity = (material, salt, kind)
        if identity in self.tested or len(self.tested) >= 65536:
            return
        self.tested.add(identity)
        self.candidates += 1
        for relative, first_page in self.headers.items():
            if time.monotonic() >= deadline:
                break
            if relative in self.keys or (salt is not None and first_page[:16] != salt):
                continue
            key = derive_key(material, first_page[:16], kind)
            if verify_key(key, first_page):
                self.keys[relative] = key

    def literals(self, data: bytes, deadline: float):
        for match in LITERAL.finditer(data):
            value = bytes.fromhex(match[1].decode("ascii"))
            self.consider(value[:32], value[32:] or None, deadline=deadline)
            if self.complete or time.monotonic() >= deadline:
                break


def scan_config(reader, matcher: KeyMatcher, deadline: float) -> dict:
    anchors = set()
    stats = {"layout": LAYOUT.label, "bytes_scanned": 0, "config_references": 0}
    for address, block in memory_chunks(reader, deadline):
        stats["bytes_scanned"] += len(block)
        matcher.literals(block, deadline)
        start = 0
        while len(anchors) < 4096:
            index = block.find(LAYOUT.marker, start)
            if index < 0:
                break
            anchors.add(address + index)
            start = index + len(LAYOUT.marker)
        if matcher.complete:
            break
    if anchors and not matcher.complete:
        references = re.compile(b"|".join(re.escape(struct.pack("<QQ", address, len(LAYOUT.marker)))
                                         for address in sorted(anchors)))
        visited = set()
        for address, block in memory_chunks(reader, deadline):
            stats["bytes_scanned"] += len(block)
            for match in references.finditer(block):
                position = address + match.start()
                if position in visited:
                    continue
                visited.add(position)
                stats["config_references"] += 1
                config = read_pointer(reader, position + LAYOUT.reference_to_config)
                if not config:
                    continue
                pair = reader.read(config + LAYOUT.config_to_buffer, 16)
                if not pair or len(pair) != 16:
                    continue
                buffer, length = struct.unpack("<QQ", pair)
                if not valid_pointer(buffer) or not 1 <= length <= 4096:
                    continue
                value = reader.read(buffer, length)
                if value is None or len(value) != length:
                    continue
                decoded = bytes(byte ^ LAYOUT.mask[i % len(LAYOUT.mask)] for i, byte in enumerate(value))
                matcher.literals(decoded, deadline)
                if matcher.complete or time.monotonic() >= deadline:
                    break
            if matcher.complete:
                break
    stats["timed_out"] = time.monotonic() >= deadline
    stats["verified_databases"] = len(matcher.keys)
    return stats


def valid_pointer(value: int) -> bool:
    return 0x10000 <= value < 0x0000800000000000


def read_pointer(reader, address: int):
    if not valid_pointer(address):
        return None
    value = reader.read(address, 8)
    if not value or len(value) != 8:
        return None
    pointer = struct.unpack("<Q", value)[0]
    return pointer if valid_pointer(pointer) else None


def read_string(reader, address: int):
    value = reader.read(address, 32)
    if not value or len(value) != 32:
        return None
    length, capacity = struct.unpack_from("<QQ", value, 16)
    if length > 1024 or length > capacity:
        return None
    if capacity == 15 and length <= 15:
        return value[:length]
    pointer = struct.unpack_from("<Q", value)[0]
    if not valid_pointer(pointer):
        return None
    data = reader.read(pointer, length)
    return data if data is not None and len(data) == length else None


# A narrow machine-code landmark, never executed or patched. Layout changes
# simply produce no authenticated key. This fallback is not required by 4.1.13+.
MASTER_PREFIX = bytes.fromhex(
    "83ec404889d64889cb0f57c00f1142100f11024c8bb1c8020000"
    "4883b9d0020000107209488b9bb8020000eb074881c3b8020000"
    "4d85f60f880a0200004983fe10736d4c89761048c746180f0000"
    "000f10030f110648b8")


def master_mask(image: bytes):
    position = image.find(MASTER_PREFIX)
    if position < 0:
        return None
    cursor = position + len(MASTER_PREFIX)
    pieces = []
    for index in range(4):
        immediate = image[cursor:cursor + 8]
        if len(immediate) != 8:
            return None
        pieces.append(immediate)
        cursor += 8
        if index < 3:
            continuation = bytes((0x48, 0x89, 0x44, 0x24, 0x20 + index * 8, 0x48, 0xB8))
            if image[cursor:cursor + 7] != continuation:
                return None
            cursor += 7
    return b"".join(pieces)


def scan_master(reader, matcher: KeyMatcher, module: tuple[int, int, str], deadline: float) -> None:
    from pathlib import Path
    base, size, filename = module
    path = Path(filename)
    if path.stat().st_size > 512 * 1024 * 1024:
        return
    mask = master_mask(path.read_bytes())
    if mask is None:
        return
    marker = b"global_config"
    for address, block in memory_chunks(reader, deadline, [(base, size)]):
        for match in re.finditer(marker, block):
            position = address + match.start()
            inline = reader.read(position + 16, 16)
            if inline != struct.pack("<QQ", len(marker), 15):
                continue
            for displacement in (0x138, 0x130):
                parent = read_pointer(reader, position + 16 - displacement)
                config = read_pointer(reader, parent + 0x68) if parent else None
                encrypted = read_string(reader, config + 0x2B8) if config else None
                if encrypted is not None and len(encrypted) == 32:
                    matcher.consider(bytes(a ^ b for a, b in zip(encrypted, mask)),
                                     kind="master", deadline=deadline)
                if matcher.complete or time.monotonic() >= deadline:
                    return
