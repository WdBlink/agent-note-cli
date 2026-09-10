"""Optional macOS/Linux acceptance: python3 test/terminal-pty.py. No real providers."""
import errno
import fcntl
import json
import os
import pathlib
import pty
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time

repo = pathlib.Path(__file__).resolve().parents[1]


class App:
    def __init__(self, args, env=None):
        self.master, slave = pty.openpty()
        self.before = termios.tcgetattr(slave)
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 28, 112, 0, 0))
        self.child = subprocess.Popen([shutil.which('node'), str(repo / 'src/cli.mjs'), 'ui', *args],
                                      stdin=slave, stdout=slave, stderr=slave, cwd=repo,
                                      env={**os.environ, 'TERM': 'xterm-256color', 'NO_COLOR': '1', 'AGENT_NOTE_NO_UPDATE_CHECK': '1', **(env or {})}, start_new_session=True)
        self.slave = slave
        self.buffer = b''
        self.cursor = 0

    def expect(self, text, timeout=12):
        deadline = time.monotonic() + timeout
        expected = text.encode()
        while time.monotonic() < deadline:
            found = self.buffer.find(expected, self.cursor)
            if found >= 0:
                self.cursor = found + len(expected)
                return
            if select.select([self.master], [], [], 0.1)[0]:
                try:
                    self.buffer += os.read(self.master, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
            if self.child.poll() is not None:
                break
        raise AssertionError(f'Missing {text!r}; recent output:\n{self.buffer[-7000:].decode(errors="replace")}')

    def send(self, text):
        self.cursor = len(self.buffer)
        os.write(self.master, text.encode())

    def back(self, title):
        self.send('\x1b')
        self.expect('/    ' + title)

    def drain(self):
        if select.select([self.master], [], [], 0.05)[0]:
            try:
                self.buffer += os.read(self.master, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise

    def close(self):
        if self.child.poll() is None:
            os.killpg(self.child.pid, signal.SIGTERM)
            deadline = time.monotonic() + 6
            while self.child.poll() is None and time.monotonic() < deadline:
                self.drain()
            if self.child.poll() is None:
                os.killpg(self.child.pid, signal.SIGKILL)
                self.child.wait()
        try:
            assert termios.tcgetattr(self.slave)[3] == self.before[3], 'TTY flags were not restored'
        finally:
            os.close(self.master)
            os.close(self.slave)


with tempfile.TemporaryDirectory(prefix='agent-note-pty-') as temporary:
    root = pathlib.Path(temporary)
    source = root / 'codex'
    source.mkdir()
    transcript = source / 'session.jsonl'
    transcript.write_text('\n'.join(json.dumps(item, ensure_ascii=False) for item in [
        {'type': 'session_meta', 'payload': {'id': 'session-1', 'cwd': temporary}},
        {'type': 'response_item', 'timestamp': '2026-08-29T01:00:00Z', 'payload': {'type': 'message', 'role': 'user',
         'content': [{'type': 'input_text', 'text': 'PTY 原文：核验导航、滚动和取消。'}]}}
    ]) + '\n')
    os.utime(transcript, (1787968800, 1787968800))
    provider = root / 'provider.mjs'
    provider.write_text(f'''#!{shutil.which('node')}
import fs from 'node:fs';
import {{ structuredRunner }} from {json.dumps((repo / 'test/model-fixture.mjs').as_uri())};
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => stdin += chunk);
process.stdin.on('end', async () => {{
  if (fs.existsSync({json.dumps(str(root / 'slow'))})) {{
    fs.writeFileSync({json.dumps(str(root / 'started'))}, 'ready');
    setInterval(() => {{}}, 1000);
  }} else {{
    const result = await structuredRunner()({{ stdin }});
    process.stdout.write(result.stdout);
  }}
}});
''')
    provider.chmod(0o700)
    settings = root / 'settings.json'
    settings.write_text(json.dumps({'codexCliPath': str(provider)}))
    args = ['--date', '2026-08-29', '--source', 'codex', '--root', str(source),
            '--data-dir', str(root / 'data'), '--settings', str(settings)]
    app = App(args)
    try:
        app.expect('/    本次更新')
        app.expect('Agent Note CLI ' + json.loads((repo / 'package.json').read_text())['version'])
        app.back('首页')
        app.send('\r')
        app.expect('生成这一天的简报')
        app.send('\r')
        app.expect('条工作线 · 已保存')
        app.send('\r')
        app.expect('可能变化 · AI 判断')
        app.send('d')
        app.expect('生成这条工作线的深读')
        app.send('\r')
        app.expect('/    工作线 / 深读')
        app.send('s')
        app.expect('/    工作线 / 来源')
        app.send('\r')
        app.expect('PTY 原文：核验导航、滚动和取消。')
        app.send('o')
        app.expect('/    直达会话 / 未打开')
        app.expect('没有经过来源校验的主会话 ID')
        app.back('来源')
        app.expect('PTY 原文：核验导航、滚动和取消。')
        app.back('工作线 / 来源')
        app.back('工作线 / 深读')
        app.back('工作线')
        app.back('工作脉络')
        app.back('首页')
        app.send('2')
        app.expect('/    日期')
        app.send('8')
        app.expect('/    选择日期')
        app.send('\x152026-02-30\r')
        app.expect('日期必须为有效的 YYYY-MM-DD')
        app.send('\x152026-08-28\r')
        app.expect('这一天没有发现会话')
        app.send('q')
        app.expect('/    首页')
        app.send('q')
        app.expect('再次退出(q)')
        app.send('q')
        app.expect('\x1b[?1049l')
        assert app.child.wait(timeout=5) == 0
    finally:
        app.close()

    (root / 'slow').write_text('1')
    app = App(args)
    try:
        app.expect('/    首页')
        app.send('\r')
        app.expect('条工作线 · 已保存')
        app.send('2')
        app.expect('/    整理工作脉络')
        deadline = time.monotonic() + 8
        while not (root / 'started').exists() and time.monotonic() < deadline:
            app.drain()
        assert (root / 'started').exists(), 'fake provider never started'
        app.send('\x1b')
        app.expect('/    工作脉络')
        assert not list((root / 'data').glob('*/writer.lock')), 'cancel left a writer lock'
        fcntl.ioctl(app.master, termios.TIOCSWINSZ, struct.pack('HHHH', 16, 38, 0, 0))
        os.kill(app.child.pid, signal.SIGWINCH)
        app.expect('返回(q)')
        app.send('\x03')
        app.expect('再次退出(Ctrl+C)')
        app.send('\x03')
        app.expect('\x1b[?1049l')
        assert app.child.wait(timeout=5) == 0
    finally:
        app.close()

    app = App([*args, '--read-only', '--color', 'always'], {'TERM_PROGRAM': 'iTerm.app', 'TMUX': '', 'STY': ''})
    try:
        app.expect('\x1b]1337;File=inline=1;')
        app.expect('/    首页')
        assert b'\x1b[48;2;28;25;22m' in app.buffer, '--color always did not restore the TUI palette'
        app.send('q')
        app.expect('再次退出(q)')
        app.send('q')
        app.expect('\x1b[?1049l')
        assert app.child.wait(timeout=5) == 0
    finally:
        app.close()

    invalid = subprocess.run([shutil.which('node'), str(repo / 'src/cli.mjs'), 'ui', '--color', 'invalid'], capture_output=True, text=True)
    assert invalid.returncode == 1 and '--color 必须' in invalid.stderr

print('PTY acceptance passed: generation, dossier, frozen source, guarded session jump, q back, confirmed q/Ctrl+C exit, invalid date, cancellation, resize and terminal restoration.')
