#!/usr/bin/env python3
"""junkmail: read a Chromium/Electron app's localStorage, for `import-t3`.

    read-localstorage.py "<app data dir>/Local Storage/leveldb" [key-prefix ...]   print as JSON
    read-localstorage.py --stage <leveldb dir> <t3 userdata> <junkmail userdata>
        write junkmail-client-import.json, which junkmail's browsers apply once
    read-localstorage.py --stage-connections <t3 userdata> <junkmail userdata>
        the same, with only the remote connections

The staged file also carries the desktop app's saved remote connections, which it keeps
encrypted with Electron's safeStorage; on macOS the key is read from the Keychain.

T3 Code's desktop app keeps its themes and UI state in Electron's localStorage, a LevelDB
database. This reads it without opening it for writing, using only the standard library:
table files (.ldb, Snappy-compressed blocks) and the write-ahead log (.log). The newest
write of each key wins, by LevelDB sequence number, so deleted keys stay deleted.
"""
import ctypes
import ctypes.util
import datetime
import glob
import hashlib
import json
import os
import struct
import subprocess
import sys


def varint(data, i):
    result = shift = 0
    while True:
        byte = data[i]
        i += 1
        result |= (byte & 0x7F) << shift
        shift += 7
        if byte < 0x80:
            return result, i


def snappy_decompress(data):
    _, i = varint(data, 0)
    out = bytearray()
    while i < len(data):
        tag = data[i]
        i += 1
        kind = tag & 3
        if kind == 0:
            length = tag >> 2
            if length >= 60:
                extra = length - 59
                length = int.from_bytes(data[i : i + extra], "little")
                i += extra
            length += 1
            out += data[i : i + length]
            i += length
            continue
        if kind == 1:
            length = ((tag >> 2) & 7) + 4
            offset = ((tag >> 5) << 8) | data[i]
            i += 1
        elif kind == 2:
            length = (tag >> 2) + 1
            offset = int.from_bytes(data[i : i + 2], "little")
            i += 2
        else:
            length = (tag >> 2) + 1
            offset = int.from_bytes(data[i : i + 4], "little")
            i += 4
        for _ in range(length):
            out.append(out[-offset])
    return bytes(out)


def block_entries(block):
    """Key/value pairs of one table block (prefix-compressed keys)."""
    restarts = struct.unpack("<I", block[-4:])[0]
    end = len(block) - 4 - 4 * restarts
    i, key = 0, b""
    while i < end:
        shared, i = varint(block, i)
        unshared, i = varint(block, i)
        value_length, i = varint(block, i)
        key = key[:shared] + block[i : i + unshared]
        i += unshared
        yield key, block[i : i + value_length]
        i += value_length


def table_records(path):
    data = open(path, "rb").read()

    def read_block(offset, size):
        raw = data[offset : offset + size]
        return snappy_decompress(raw) if data[offset + size] == 1 else raw

    footer = data[-48:]
    _, i = varint(footer, 0)
    _, i = varint(footer, i)
    index_offset, i = varint(footer, i)
    index_size, i = varint(footer, i)
    for _, handle in block_entries(read_block(index_offset, index_size)):
        offset, j = varint(handle, 0)
        size, _ = varint(handle, j)
        for internal_key, value in block_entries(read_block(offset, size)):
            trailer = int.from_bytes(internal_key[-8:], "little")
            yield internal_key[:-8], trailer >> 8, trailer & 0xFF, value


def log_records(path):
    """Write batches from the log; records may span 32 KiB blocks."""
    data = open(path, "rb").read()
    batches, pending, i = [], b"", 0
    while i + 7 <= len(data):
        block_left = 32768 - (i % 32768)
        if block_left < 7:
            i += block_left
            continue
        length = int.from_bytes(data[i + 4 : i + 6], "little")
        kind = data[i + 6]
        payload = data[i + 7 : i + 7 + length]
        i += 7 + length
        if kind == 0 and length == 0:
            continue
        if kind == 1:
            batches.append(payload)
        elif kind == 2:
            pending = payload
        elif kind == 3:
            pending += payload
        elif kind == 4:
            batches.append(pending + payload)
            pending = b""
    for batch in batches:
        sequence = int.from_bytes(batch[:8], "little")
        count = int.from_bytes(batch[8:12], "little")
        j = 12
        for n in range(count):
            kind = batch[j]
            j += 1
            key_length, j = varint(batch, j)
            key = batch[j : j + key_length]
            j += key_length
            value = b""
            if kind == 1:
                value_length, j = varint(batch, j)
                value = batch[j : j + value_length]
                j += value_length
            yield key, sequence + n, kind, value


def decode_string(raw):
    """Chromium prefixes stored strings: 0 for UTF-16LE, 1 for Latin-1."""
    if not raw:
        return ""
    if raw[0] == 0:
        return raw[1:].decode("utf-16-le", errors="replace")
    return raw[1:].decode("latin-1")


def read_entries(directory, prefixes):
    newest = {}
    files = glob.glob(os.path.join(directory, "*.ldb")) + glob.glob(os.path.join(directory, "*.log"))
    for path in files:
        records = table_records if path.endswith(".ldb") else log_records
        try:
            for key, sequence, kind, value in records(path):
                current = newest.get(key)
                if current is None or sequence > current[0]:
                    newest[key] = (sequence, kind, value)
        except Exception as error:  # A torn file costs its own keys, not the import.
            print(f"skipped {os.path.basename(path)}: {error}", file=sys.stderr)
    entries = {}
    for key, (_, kind, value) in newest.items():
        # Keys look like b"_<origin>\x00" + encoded name; metadata keys start with "META".
        if not key.startswith(b"_") or b"\x00" not in key or kind != 1:
            continue
        name = decode_string(key.split(b"\x00", 1)[1])
        if any(name.startswith(prefix) for prefix in prefixes):
            entries[name] = decode_string(value)
    return entries


def read_environment_id(folder):
    path = os.path.join(folder, "environment-id")
    return open(path).read().strip() if os.path.isfile(path) else ""


def safe_storage_key(blob):
    """The AES key Electron's safeStorage used for `blob`, as Chromium derives it."""
    password = os.environ.get("JUNKMAIL_SAFE_STORAGE_PASSWORD")
    if password is None and sys.platform == "darwin":
        # macOS asks once whether `security` may read the item; "Allow" is enough.
        password = subprocess.run(
            ["security", "find-generic-password", "-w", "-s", "t3code Safe Storage"],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
    if sys.platform == "darwin" or password is not None:
        return hashlib.pbkdf2_hmac("sha1", password.encode(), b"saltysalt", 1003, 16)
    if blob.startswith(b"v10"):  # Linux without a keyring: a fixed, public password.
        return hashlib.pbkdf2_hmac("sha1", b"peanuts", b"saltysalt", 1, 16)
    raise RuntimeError("the desktop app encrypted it with the system keyring")


def aes_128_cbc_decrypt(key, data):
    iv = b" " * 16
    if sys.platform == "darwin":
        # CommonCrypto, so the key never appears in a command line.
        lib = ctypes.CDLL(ctypes.util.find_library("System"))
        out = ctypes.create_string_buffer(len(data) + 16)
        moved = ctypes.c_size_t(0)
        status = lib.CCCrypt(1, 0, 1, key, len(key), iv, data, ctypes.c_size_t(len(data)),
                             out, ctypes.c_size_t(len(out)), ctypes.byref(moved))
        if status != 0:
            raise RuntimeError(f"decryption failed ({status})")
        return out.raw[: moved.value]
    return subprocess.run(
        ["openssl", "enc", "-d", "-aes-128-cbc", "-K", key.hex(), "-iv", iv.hex()],
        input=data, capture_output=True, check=True,
    ).stdout


def read_connection_catalog(source):
    """The desktop app's saved remote connections, reduced to the ones a browser can use.

    Bearer connections carry their own token. Relay connections only name the environment;
    the browser signs in to T3 Connect itself, since relay tokens are bound to the device
    that minted them. SSH tunnels need the desktop app, so they are left behind.
    """
    path = os.path.join(source, "connection-catalog.json")
    if not os.path.isfile(path):
        return None, 0
    import base64

    blob = base64.b64decode(json.load(open(path))["encryptedCatalog"])
    catalog = json.loads(aes_128_cbc_decrypt(safe_storage_key(blob), blob[3:]))
    targets = [t for t in catalog.get("targets", []) if t.get("_tag") != "SshConnectionTarget"]
    connection_ids = {t["connectionId"] for t in targets if "connectionId" in t}
    kept = {
        "schemaVersion": 1,
        "targets": targets,
        "profiles": [
            p for p in catalog.get("profiles", [])
            if p.get("_tag") == "BearerConnectionProfile" and p.get("connectionId") in connection_ids
        ],
        "credentials": [
            c for c in catalog.get("credentials", []) if c.get("connectionId") in connection_ids
        ],
        "remoteDpopTokens": [],
        "disabledEnvironmentIds": [
            e for e in catalog.get("disabledEnvironmentIds", [])
            if any(t["environmentId"] == e for t in targets)
        ],
    }
    return kept, len(catalog.get("targets", [])) - len(targets)


def stage(leveldb, source, destination):
    entries = read_entries(leveldb, ["t3code:"]) if leveldb and os.path.isdir(leveldb) else {}
    # The desktop app keeps client settings in a file; browsers keep them under this key.
    settings = os.path.join(source, "client-settings.json")
    if leveldb and os.path.isfile(settings):
        entries["t3code:client-settings:v1"] = open(settings).read()
    # Per-thread state is keyed by environment id; junkmail has its own.
    old_id, new_id = read_environment_id(source), read_environment_id(destination)
    if old_id and new_id:
        entries = {k.replace(old_id, new_id): v.replace(old_id, new_id) for k, v in entries.items()}
    staged = {
        "importedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "entries": entries,
    }
    try:
        catalog, skipped = read_connection_catalog(source)
    except subprocess.CalledProcessError:
        catalog, skipped = None, 0
        print("    Skipped remote connections: Keychain access was not allowed", file=sys.stderr)
    except Exception as error:
        catalog, skipped = None, 0
        print(f"    Skipped remote connections: could not decrypt them ({error})", file=sys.stderr)
    if catalog is not None:
        staged["connectionCatalog"] = json.dumps(catalog)
    # Connection tokens are secrets; only this user may read the staged copy.
    path = os.path.join(destination, "junkmail-client-import.json")
    with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as out:
        json.dump(staged, out, ensure_ascii=False)
    os.chmod(path, 0o600)
    theme = entries.get("t3code:theme")
    if leveldb:
        print(f"    {len(entries)} settings" + (f", theme {theme}" if theme else ""))
    if catalog is None and not leveldb:
        print("    No saved remote connections found")
    if catalog is not None:
        print(f"    {len(catalog['targets'])} remote connections"
              + (f"; {skipped} over SSH need the desktop app" if skipped else ""))


def main():
    if sys.argv[1] == "--stage":
        stage(*sys.argv[2:5])
        return
    if sys.argv[1] == "--stage-connections":
        stage(None, *sys.argv[2:4])
        return
    json.dump(read_entries(sys.argv[1], sys.argv[2:] or ["t3code:"]), sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
