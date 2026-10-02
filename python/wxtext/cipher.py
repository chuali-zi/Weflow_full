"""Authenticated SQLCipher 4 page decoding; no access to live processes here."""
from dataclasses import dataclass, field
import hashlib
import hmac
from pathlib import Path
import sqlite3
import struct

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

from .errors import ToolError


@dataclass(frozen=True)
class CipherProfile:
    name: str = "sqlcipher4-4096"
    page_size: int = 4096
    reserve: int = 80
    iterations: int = 256_000
    salt_size: int = 16


PROFILE = CipherProfile()
SQLITE_HEADER = b"SQLite format 3\x00"


@dataclass(frozen=True)
class DatabaseKey:
    secret: bytes = field(repr=False)
    salt: bytes = field(repr=False)
    profile: str = PROFILE.name

    def __post_init__(self):
        if len(self.secret) != 32 or len(self.salt) != 16 or self.profile != PROFILE.name:
            raise ToolError("INVALID_KEY", "密钥长度、盐长度或加密配置不受支持。")


def derive_key(material: bytes, salt: bytes, kind: str = "raw") -> DatabaseKey:
    if kind not in {"raw", "master"}:
        raise ToolError("INVALID_KEY", "密钥种类必须为 raw 或 master。")
    if len(material) != 32 or len(salt) != 16:
        raise ToolError("INVALID_KEY", "密钥材料长度不正确。")
    secret = material if kind == "raw" else hashlib.pbkdf2_hmac(
        "sha512", material, salt, PROFILE.iterations, 32)
    return DatabaseKey(secret, salt)


class PageCipher:
    def __init__(self, key: DatabaseKey):
        self.key = key
        self.mac_key = hashlib.pbkdf2_hmac(
            "sha512", key.secret, bytes(x ^ 0x3A for x in key.salt), 2, 32)

    def authenticate(self, page: bytes, number: int) -> bool:
        if len(page) != PROFILE.page_size or not 1 <= number <= 0xFFFFFFFF:
            return False
        if number == 1 and page[:16] != self.key.salt:
            return False
        start = 16 if number == 1 else 0
        digest = hmac.digest(self.mac_key, page[start:-64] + struct.pack("<I", number), "sha512")
        return hmac.compare_digest(digest, page[-64:])

    def decrypt(self, page: bytes, number: int) -> bytes:
        if not self.authenticate(page, number):
            raise ToolError("PAGE_AUTH_FAILED", "数据库页认证失败；密钥、格式或文件可能不匹配。",
                            "重新 prepare；若仍失败，请保留错误页号用于本地适配。", {"page": number})
        start = 16 if number == 1 else 0
        end = PROFILE.page_size - PROFILE.reserve
        decoder = Cipher(algorithms.AES(self.key.secret), modes.CBC(page[end:end + 16])).decryptor()
        plain = decoder.update(page[start:end]) + decoder.finalize()
        result = (SQLITE_HEADER if number == 1 else b"") + plain + bytes(PROFILE.reserve)
        if number == 1:
            page_size = int.from_bytes(result[16:18], "big")
            if page_size != PROFILE.page_size or result[20] != PROFILE.reserve:
                raise ToolError("UNSUPPORTED_FORMAT", "解密后的 SQLite 页布局与支持配置不符。")
        return result


def verify_key(key: DatabaseKey, first_page: bytes) -> bool:
    return PageCipher(key).authenticate(first_page, 1)


def open_readonly(path: Path) -> sqlite3.Connection:
    # Only immutable, private snapshots may be opened through this function.
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro&immutable=1", uri=True)
    connection.row_factory = sqlite3.Row
    connection.text_factory = lambda b: b.decode("utf-8") if _is_utf8(b) else b
    connection.execute("PRAGMA query_only=ON")
    connection.execute("PRAGMA trusted_schema=OFF")
    return connection


def _is_utf8(value: bytes) -> bool:
    try:
        value.decode("utf-8")
        return True
    except UnicodeDecodeError:
        return False


def decrypt_database(source: Path, output: Path, key: DatabaseKey) -> None:
    if source.resolve() == output.resolve():
        raise ToolError("UNSAFE_PATH", "解密输出不能覆盖源数据库。")
    size = source.stat().st_size
    if size < PROFILE.page_size or size % PROFILE.page_size:
        raise ToolError("UNSUPPORTED_FORMAT", "数据库长度不是完整的 4096 字节页。")
    decoder = PageCipher(key)
    created = False
    try:
        with source.open("rb") as incoming, output.open("xb") as outgoing:
            created = True
            for number in range(1, size // PROFILE.page_size + 1):
                outgoing.write(decoder.decrypt(incoming.read(PROFILE.page_size), number))
        connection = open_readonly(output)
        try:
            check = [row[0] for row in connection.execute("PRAGMA integrity_check")]
            if check != ["ok"]:
                # SQLite errors may contain cell contents: do not log their text.
                raise ToolError("INTEGRITY_FAILED", "解密后的数据库未通过完整性检查。")
        finally:
            connection.close()
    except BaseException:
        if created:
            output.unlink(missing_ok=True)
        raise
