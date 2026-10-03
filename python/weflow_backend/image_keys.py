"""Account-scoped DAT key discovery; candidates must decrypt a local image.

Format/derivation reference: wechatauto-replica/wechatauto/media.py.
No process writes, remote downloads, or plaintext secret cache.
"""
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import time

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from wxtext.errors import ToolError
from wxtext.keyscan import memory_chunks, read_pointer, read_string
from wxtext.state import atomic_write
from wxtext.windows import ProcessReader

V2 = bytes.fromhex('070856320807')
ASCII_KEY = re.compile(rb'(?<![A-Za-z0-9])[A-Za-z0-9]{16,32}(?![A-Za-z0-9])')
WIDE_KEY = re.compile(rb'(?:[A-Za-z0-9]\x00){16,32}')


def image_header(data):
    return (data.startswith(b'\xff\xd8\xff') or data.startswith(b'\x89PNG\r\n\x1a\n')
            or data.startswith((b'GIF87a', b'GIF89a', b'wxgf'))
            or (data[:4] == b'RIFF' and data[8:12] == b'WEBP'))


def decrypt_v2(data, key, xor):
    if len(data) < 31 or data[:6] != V2:
        raise ValueError('invalid DAT header')
    aes_size, xor_size = struct.unpack_from('<II', data, 6)
    length = aes_size + 16 - aes_size % 16
    if length > len(data) - 15 or xor_size > len(data) - 15 - length:
        raise ValueError('incomplete DAT')
    decoder = Cipher(algorithms.AES(key), modes.ECB()).decryptor()
    head = decoder.update(data[15:15+length]) + decoder.finalize()
    padding = head[-1]
    if not 1 <= padding <= 16 or head[-padding:] != bytes([padding]) * padding:
        raise ValueError('invalid DAT padding')
    head = head[:-padding]
    if len(head) != aes_size or not image_header(head):
        raise ValueError('invalid image key')
    split = len(data) - xor_size
    return head + data[15+length:split] + bytes(b ^ xor for b in data[split:])


def samples(account_dir, limit=32):
    files = list((account_dir / 'msg' / 'attach').glob('*/*/Img/*_t.dat'))
    if not files:
        files = list((account_dir / 'msg' / 'attach').glob('*/*/Img/*.dat'))
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    result = []
    for path in files[:limit]:
        try:
            with path.open('rb') as stream:
                header = stream.read(31)
                if header[:6] != V2:
                    continue
                size, tail_size = struct.unpack_from('<II', header, 6)
                padded = size + 16 - size % 16
                if not 16 <= size <= 1024 * 1024 or padded + tail_size + 15 > path.stat().st_size:
                    continue
                stream.seek(15)
                cipher = stream.read(padded)
                stream.seek(-2, 2)
                tail = stream.read(2) if tail_size >= 2 else b''
            result.append((path, cipher, size, tail))
        except OSError:
            continue
    return result


def validated(key, probes):
    if len(key) != 16 or not probes:
        return False
    # Full encrypted prefix + strict padding, not just a short magic match.
    try:
        for _, cipher, size, _ in probes[:3]:
            dec = Cipher(algorithms.AES(key), modes.ECB()).decryptor()
            data = dec.update(cipher) + dec.finalize()
            padding = len(data) - size
            if not image_header(data) or not 1 <= padding <= 16 or data[-padding:] != bytes([padding]) * padding:
                return False
        return True
    except ValueError:
        return False


def acquire(account_dir, state, source, progress=lambda message: None, refresh=False, timeout=60):
    account_dir = Path(account_dir).resolve()
    probes = samples(account_dir)
    if not probes:
        return {'success': False, 'error': '没有可验证的本地 V2 图片，请先在微信中打开一张图片，再重试。'}
    identity = os.path.normcase(str(account_dir))
    cache = state.root / 'image-keys' / (hashlib.sha256(identity.encode()).hexdigest() + '.dpapi')
    if cache.exists() and not refresh:
        try:
            saved = json.loads(state.unprotect(cache.read_bytes()))
            if saved['account_dir'] == identity and validated(saved['aesKey'].encode('ascii'), probes):
                return {'success': True, 'aesKey': saved['aesKey'], 'xorKey': saved['xorKey'], 'verified': True}
        except (ValueError, KeyError, UnicodeError, ToolError):
            pass
    processes = source.processes()
    # The UI/utility subprocesses do not own the WCDB config or image key.
    eligible = []
    for process in processes:
        try:
            if list(source.modules(process.pid)):
                eligible.append(process)
        except ToolError:
            continue
    processes = eligible or processes
    if not processes:
        return {'success': False, 'error': '请保持微信登录，再获取图片密钥。'}
    wxid = re.sub(r'_[A-Za-z0-9]{4}$', '', account_dir.name)
    deadline = time.monotonic() + timeout
    tail_keys = Counter(a[0] ^ 0xff for *_, a in probes if len(a) == 2 and a[0] ^ 0xff == a[1] ^ 0xd9)

    def accept(key, xor=None):
        if not validated(key, probes):
            return None
        if xor is None:
            if not tail_keys:
                return None
            xor = tail_keys.most_common(1)[0][0]
        # Verify tail against JPEG end markers for several real files.
        for path, _, _, _ in probes[:3]:
            plain = decrypt_v2(path.read_bytes(), key, xor)
            if plain.startswith(b'\xff\xd8\xff') and b'\xff\xd9' not in plain[-34:]:
                return None
        value = {'account_dir': identity, 'aesKey': key.decode('ascii'), 'xorKey': xor}
        atomic_write(cache, state.protect(json.dumps(value).encode()))
        return {'success': True, 'aesKey': value['aesKey'], 'xorKey': xor, 'verified': True}

    for process in processes:
        if time.monotonic() >= deadline:
            break
        progress(f'只读检查微信图片密钥（PID {process.pid}），用本地图片验证…')
        try:
            with source.handle(process.pid, 0x0400 | 0x0010) as handle:
                reader = ProcessReader(source, handle)
                # Version-sensitive global_config landmark. Accept only the
                # selected account and a fully validated decrypted image prefix.
                for base, size, _ in source.modules(process.pid):
                    for address, block in memory_chunks(reader, deadline, [(base, size)]):
                        for match in re.finditer(b'global_config', block):
                            position = address + match.start()
                            if reader.read(position + 16, 16) != struct.pack('<QQ', 13, 15):
                                continue
                            for displacement in (0x138, 0x130):
                                parent = read_pointer(reader, position + 16 - displacement)
                                config = read_pointer(reader, parent + 0x68) if parent else None
                                if not config or read_string(reader, config + 0x48) != wxid.encode():
                                    continue
                                value = reader.read(config + 0x40, 4)
                                if value and len(value) == 4:
                                    dword = struct.unpack('<I', value)[0]
                                    key = hashlib.md5((str(dword) + wxid).encode()).hexdigest()[:16].encode()
                                    result = accept(key, dword & 255)
                                    if result:
                                        return result
                tested = set()
                for _, block in memory_chunks(reader, deadline):
                    for pattern, wide in ((ASCII_KEY, False), (WIDE_KEY, True)):
                        for match in pattern.finditer(block):
                            if time.monotonic() >= deadline:
                                break
                            key = match[0][::2][:16] if wide else match[0][:16]
                            if key not in tested:
                                tested.add(key)
                                # Fast first-block filter before full padding validation.
                                dec = Cipher(algorithms.AES(key), modes.ECB()).decryptor()
                                if image_header(dec.update(probes[0][1][:16])):
                                    result = accept(key)
                                    if result:
                                        return result
        except ToolError:
            continue
    return {'success': False, 'error': '未找到可验证的图片密钥，请在微信中点击一张图片查看大图，再重试获取。'}
