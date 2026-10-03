"""Small SQLCipher adapter used by the persistent live backend.

The module deliberately contains no WeFlow query logic.  It only opens an
authenticated, read-only SQLCipher connection and provides the inexpensive
data-version probe used by the backend's monitor loop.
"""
from contextlib import contextmanager
from pathlib import Path
import importlib
import sqlite3

from wxtext.cipher import DatabaseKey
from wxtext.errors import ToolError


def _engine():
    try:
        return importlib.import_module("sqlcipher3.dbapi2")
    except (ImportError, ModuleNotFoundError) as error:
        raise ToolError("LIVE_ENGINE_UNAVAILABLE", "在线读取引擎未安装。",
                        "请安装正式 sqlcipher3 运行库后重试。") from error


def connect(path: Path, key: DatabaseKey, timeout: float = 0.25):
    """Open one source database without immutable or write access.

    SQLCipher's raw-key form includes the database salt.  The first real
    sqlite query is intentionally part of opening: PRAGMA key itself does not
    prove that authentication succeeded.
    """
    if not isinstance(key, DatabaseKey):
        raise ToolError("INVALID_KEY", "数据库密钥格式错误。")
    path = Path(path).resolve()
    if not path.is_file():
        raise ToolError("SOURCE_REPLACED", "源数据库不存在。", details={"file": str(path)})
    engine = _engine()
    connection = None
    try:
        connection = engine.connect(path.as_uri() + "?mode=ro", uri=True,
                                    isolation_level=None, timeout=timeout)
        connection.row_factory = engine.Row
        connection.execute("PRAGMA key = \"x'" + key.secret.hex() + key.salt.hex() + "'\"")
        connection.execute("PRAGMA cipher_compatibility=4")
        connection.execute("PRAGMA query_only=ON")
        connection.execute("PRAGMA trusted_schema=OFF")
        connection.execute("SELECT name FROM sqlite_master LIMIT 1").fetchone()
        # Keep this as metadata only; callers may expose it in diagnostics.
        # sqlite3.Connection objects do not all allow custom attributes; the
        # version is queried by callers only when the engine exposes it.
        return connection
    except ToolError:
        if connection is not None:
            connection.close()
        raise
    # sqlcipher3.Error is a driver-specific exception and is not guaranteed to
    # inherit from the stdlib sqlite3.Error class.
    except Exception as error:
        if connection is not None:
            connection.close()
        if "locked" in str(error).casefold() or "busy" in str(error).casefold():
            raise ToolError("LIVE_BUSY", "数据库暂时繁忙，请稍后重试。") from error
        raise ToolError("LIVE_AUTH_FAILED", "在线数据库认证或读取失败。",
                        "请检查已缓存密钥和账号目录。") from error


def data_version(connection) -> int:
    return int(connection.execute("PRAGMA data_version").fetchone()[0])


@contextmanager
def read_transaction(connection):
    """A short transaction.  No cursor escapes this context."""
    connection.execute("BEGIN")
    try:
        yield connection
    except BaseException:
        try:
            connection.execute("ROLLBACK")
        finally:
            raise
    else:
        connection.execute("COMMIT")


def close_all(connections):
    for connection in list(connections.values()):
        try:
            connection.close()
        except Exception:
            pass
    connections.clear()
