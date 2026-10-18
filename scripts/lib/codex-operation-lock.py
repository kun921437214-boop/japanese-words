"""POSIX advisory lock held until the Node caller closes stdin or exits."""
import fcntl
import os
from pathlib import Path
import stat
import sys

lock = Path(sys.argv[1])
if lock.parent.resolve(strict=True) != lock.parent:
    raise RuntimeError('REDIRECTED_LOCK_DIRECTORY')
directory = lock.parent.stat()
if directory.st_uid != os.getuid() or stat.S_IMODE(directory.st_mode) & 0o077:
    raise RuntimeError('UNSAFE_LOCK_DIRECTORY')
fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
try:
    metadata = os.fstat(fd)
    if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid()
            or stat.S_IMODE(metadata.st_mode) & 0o077):
        raise RuntimeError('UNSAFE_LOCK_FILE')
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        sys.exit(73)
    print('LOCKED', flush=True)
    sys.stdin.buffer.read()
finally:
    os.close(fd)
