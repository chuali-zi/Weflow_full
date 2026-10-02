"""Strict WAL replay for private, stopped-client encrypted snapshots only."""
from pathlib import Path
import struct

from .cipher import DatabaseKey, PageCipher, PROFILE
from .errors import ToolError


def _checksum(data: bytes, order: str, seed=(0, 0)) -> tuple[int, int]:
    first, second = seed
    for left, right in struct.iter_unpack(order + "II", data):
        first = (first + left + second) & 0xFFFFFFFF
        second = (second + right + first) & 0xFFFFFFFF
    return first, second


def apply_wal(path: Path, key: DatabaseKey) -> dict:
    """Replay authenticated ciphertext, never a live/source database.

    The caller must supply an exclusively owned private snapshot and sidecar.
    All active-generation frames must validate, even after the last commit.
    Only a complete frame header with mismatching salts ends that generation;
    the entire suffix is then ignored without parsing, even partial frame bytes.
    Short active headers and matching-salt truncated pages are invalid.
    Validation errors leave
    both files untouched; write/I/O failures are not transactionally recoverable.
    Metadata counts active frames, frames through the last commit, distinct
    pages written, and the resulting size (None for absent/empty WALs).
    stale_bytes includes the mismatching header and all bytes after it;
    stale_frames is stale_bytes // frame_size, without validating those frames.
    """
    result = {"status": "absent", "frames": 0, "commits": 0,
              "committed_frames": 0, "ignored_frames": 0, "stale_frames": 0, "stale_bytes": 0,
              "pages_replayed": 0, "database_pages": None}
    wal_path = Path(str(path) + "-wal")
    try:
        incoming = wal_path.open("rb")
    except FileNotFoundError:
        return result
    with incoming:
        size = incoming.seek(0, 2)
        if not size:
            return dict(result, status="empty")
        page_size = PROFILE.page_size
        frame_size = 24 + page_size
        if size < 32:
            raise ToolError("INVALID_WAL", "WAL contains an incomplete header.")
        count = (size - 32) // frame_size
        incoming.seek(0)
        header = incoming.read(32)
        magic, version, wal_page_size, _, salt1, salt2, check1, check2 = struct.unpack(
            ">8I", header)
        if magic not in (0x377F0682, 0x377F0683) or version != 3007000 or wal_page_size != 4096:
            raise ToolError("INVALID_WAL", "Unsupported WAL magic, version, or page size.")
        order = "<" if magic == 0x377F0682 else ">"
        checksum = _checksum(header[:24], order)
        if checksum != (check1, check2):
            raise ToolError("INVALID_WAL", "WAL header checksum mismatch.")
        database_size = path.stat().st_size
        if not database_size or database_size % page_size:
            raise ToolError("INVALID_WAL", "Snapshot must contain complete 4096-byte pages.")
        current_pages = database_size // page_size
        bound = current_pages + count
        cipher = PageCipher(key)
        committed = {}
        pending = {}
        active_count = 0
        for offset in range(32, size, frame_size):
            index = active_count + 1
            frame_header = incoming.read(24)
            if len(frame_header) != 24:
                raise ToolError("INVALID_WAL", "WAL contains an incomplete active frame header.")
            number, commit_size, s1, s2, c1, c2 = struct.unpack(">6I", frame_header)
            if (s1, s2) != (salt1, salt2):
                # SQLite can reuse a WAL without truncating the old generation.
                result["stale_bytes"] = size - offset
                result["stale_frames"] = result["stale_bytes"] // frame_size
                break
            page = incoming.read(page_size)
            if len(page) != page_size:
                raise ToolError("INVALID_WAL", "WAL contains an incomplete active frame page.")
            if not 1 <= number <= min(bound, 0xFFFFFFFE) or commit_size > min(bound, 0xFFFFFFFE):
                raise ToolError("INVALID_WAL", "WAL page number or commit size exceeds replay bounds.")
            checksum = _checksum(frame_header[:8] + page, order, checksum)
            if checksum != (c1, c2):
                raise ToolError("INVALID_WAL", "WAL frame checksum mismatch.", details={"frame": index})
            if not cipher.authenticate(page, number):
                raise ToolError("PAGE_AUTH_FAILED", "WAL page authentication failed.",
                                details={"page": number, "frame": index})
            active_count += 1
            pending[number] = 32 + (index - 1) * frame_size + 24
            if commit_size:
                if any(number not in pending for number in range(current_pages + 1, commit_size + 1)):
                    raise ToolError("INVALID_WAL", "WAL commit leaves missing growth pages.")
                committed.update(pending)
                # A later growth must supply fresh pages after a committed shrink.
                committed = {n: offset for n, offset in committed.items() if n <= commit_size}
                pending.clear()
                current_pages = commit_size
                result["commits"] += 1
                result["committed_frames"] = index
        result.update(status="replayed" if result["commits"] else "uncommitted",
                      frames=active_count, ignored_frames=active_count - result["committed_frames"],
                      pages_replayed=len(committed), database_pages=current_pages)
        if result["commits"]:
            with path.open("r+b") as outgoing:
                for number, offset in sorted(committed.items()):
                    incoming.seek(offset)
                    outgoing.seek((number - 1) * page_size)
                    outgoing.write(incoming.read(page_size))
                outgoing.truncate(current_pages * page_size)
        return result
