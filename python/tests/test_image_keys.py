import struct
import unittest
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from weflow_backend.image_keys import decrypt_v2, validated


def encode_v2(plain, key=b'0123456789abcdef', xor=0x53, aes_size=32, xor_size=8):
    padding = 16 - aes_size % 16
    encoder = Cipher(algorithms.AES(key), modes.ECB()).encryptor()
    encrypted = encoder.update(plain[:aes_size] + bytes([padding]) * padding) + encoder.finalize()
    return bytes.fromhex('070856320807') + struct.pack('<II', aes_size, xor_size) + b'\x00' + encrypted + plain[aes_size:-xor_size] + bytes(b ^ xor for b in plain[-xor_size:])


class ImageKeyTests(unittest.TestCase):
    def test_v2_full_block_padding_and_xor_tail(self):
        plain = b'\xff\xd8\xff' + bytes(range(80)) + b'\xff\xd9'
        encrypted = encode_v2(plain)
        self.assertEqual(decrypt_v2(encrypted, b'0123456789abcdef', 0x53), plain)
        probes = [(None, encrypted[15:63], 32, encrypted[-2:])]
        self.assertTrue(validated(b'0123456789abcdef', probes))
        self.assertFalse(validated(b'fedcba9876543210', probes))
        with self.assertRaises(ValueError):
            decrypt_v2(encrypted[:50], b'0123456789abcdef', 0x53)

    def test_wxgf_header_is_accepted(self):
        plain = b'wxgf' + bytes(range(80))
        encrypted = encode_v2(plain)
        self.assertEqual(decrypt_v2(encrypted, b'0123456789abcdef', 0x53), plain)
