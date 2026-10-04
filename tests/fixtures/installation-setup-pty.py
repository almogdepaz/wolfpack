"""Run real interactive setup with a bounded, invocation-owned controlling PTY."""
import errno
import json
import os
import select
import signal
import sys
import time

answers = sys.stdin.buffer.read()
pid, fd = os.forkpty()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])

output = bytearray()
status = None
timed_out = False
try:
    os.write(fd, answers)
    deadline = time.monotonic() + 15
    while status is None and time.monotonic() < deadline:
        if select.select([fd], [], [], 0.1)[0]:
            try:
                chunk = os.read(fd, 4096)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                chunk = b""
            output.extend(chunk)
        reaped, value = os.waitpid(pid, os.WNOHANG)
        if reaped:
            status = value
    timed_out = status is None
finally:
    if status is None:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        _, status = os.waitpid(pid, 0)
    os.close(fd)
    with open(os.path.join(os.environ["HOME"], "setup-receipt.json"), "w") as receipt:
        json.dump({"pid": pid, "status": status, "timedOut": timed_out, "output": output.decode(errors="replace")}, receipt)
    sys.stdout.buffer.write(output)

if timed_out:
    sys.exit(124)
# `os.waitstatus_to_exitcode` is absent from the system Python on supported
# macOS installations. Keep ordinary child exits and expose signal termination
# as conventional nonzero shell statuses (128 + signal); raw wait status stays
# in setup-receipt.json and is intentionally not claimed equivalent.
if os.WIFEXITED(status):
    sys.exit(os.WEXITSTATUS(status))
if os.WIFSIGNALED(status):
    sys.exit(128 + os.WTERMSIG(status))
sys.exit(1)
