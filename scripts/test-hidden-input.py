#!/usr/bin/env python3
"""Exercise real terminal echo behavior using placeholders, without real secrets."""
import errno
import os
from pathlib import Path
import pty
import select
import subprocess
import termios
import time

ROOT = Path(__file__).resolve().parent.parent
IMPORT = "import { hiddenInput } from './server/configure-ops-alert.mjs'; "


def run_terminal(code, steps, success_marker):
    master, slave = pty.openpty()
    initial_flags = termios.tcgetattr(master)
    process = subprocess.Popen(
        ['node', '--input-type=module', '-e', IMPORT + code],
        cwd=ROOT, stdin=slave, stdout=slave, stderr=slave,
    )
    os.close(slave)
    captured = b''
    step = 0
    deadline = time.monotonic() + 5
    try:
        # Drain to terminal EOF, including bytes queued just before process exit.
        while time.monotonic() < deadline:
            readable, _, _ = select.select([master], [], [], 0.1)
            if readable:
                try:
                    chunk = os.read(master, 4096)
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
                if not chunk:
                    break
                captured += chunk
            if step < len(steps) and steps[step][0] in captured:
                assert not termios.tcgetattr(master)[3] & termios.ECHO, 'Echo enabled when prompt became visible'
                os.write(master, steps[step][1])
                step += 1
        assert process.wait(timeout=1) == 0, 'Terminal test process failed'
        assert step == len(steps), 'A prompt did not arrive'
        assert success_marker in captured, 'Completion marker missing'
        for _, value in steps:
            for component in value.replace(b'\x7f', b'').split(b'\r'):
                if len(component) > 3:
                    assert component not in captured, 'Placeholder input was echoed'
        # Echo/canonical settings must be restored for the user's shell.
        restored_flags = termios.tcgetattr(master)
        assert restored_flags[3] == initial_flags[3], 'Terminal local flags were not restored'
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)


run_terminal(
    "const v=await hiddenInput('PROMPT_ONE:'); if(v!=='placeholder-stdin-test') process.exitCode=1; else console.log('ACCEPTED');",
    [(b'PROMPT_ONE:', b'placeholder-stdin-test\r')], b'ACCEPTED',
)
run_terminal(
    "const a=await hiddenInput('FIRST:'); const b=await hiddenInput('SECOND:'); if(a!=='placeholder-url' || b!=='placeholder-sign') process.exitCode=1; else console.log('TWO_ACCEPTED');",
    [(b'FIRST:', b'placeholder-url\r'), (b'SECOND:', b'placeholder-sign\r')], b'TWO_ACCEPTED',
)
run_terminal(
    "const v=await hiddenInput('EDIT:'); if(v!=='placeholder-edit') process.exitCode=1; else console.log('EDIT_ACCEPTED');",
    [(b'EDIT:', b'placeholder-edix\x7ft\r')], b'EDIT_ACCEPTED',
)
run_terminal(
    "try { await hiddenInput('ABORT:'); process.exitCode=1; } catch(e) { if(e.message!=='INPUT_ABORTED') process.exitCode=1; else console.log('ABORT_ACCEPTED'); }",
    [(b'ABORT:', b'\x03')], b'ABORT_ACCEPTED',
)
non_terminal = subprocess.run(
    ['node', '--input-type=module', '-e', IMPORT + "try { await hiddenInput('NO_TTY:'); process.exitCode=1; } catch(e) { if(e.message!=='INTERACTIVE_TERMINAL_REQUIRED') process.exitCode=1; }"],
    cwd=ROOT, input=b'placeholder-must-not-be-read', capture_output=True,
)
assert non_terminal.returncode == 0, 'Non-terminal input was accepted'
assert not non_terminal.stdout and not non_terminal.stderr, 'Non-terminal input was printed'
print('Hidden input PTY checks passed: immediate paste, two prompts, backspace, abort, non-TTY rejection, and terminal restoration.')
