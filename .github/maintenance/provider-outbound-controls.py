"""Controlled checks for a staged test-only patch; never used by production."""
from pathlib import Path
import json
import os
import re
import shutil
import subprocess
import tempfile
import time

root = Path('.tmp/provider-outbound-repair')
fixture = Path('tests/fixtures/provider-outbound-e2e.ts')
candidate = fixture.read_text(encoding='utf-8')
baseline = subprocess.check_output(['git', 'show', 'HEAD:' + fixture.as_posix()], text=True, encoding='utf-8')
baseline_path = fixture.with_name('provider-outbound-e2e.baseline-diagnostic.ts')
baseline_path.write_text(baseline, encoding='utf-8', newline='\n')
preload = root / 'slow-dns.ts'
preload.write_text('''import { mock } from "bun:test";
import * as dns from "node:dns/promises";
mock.module("node:dns/promises", () => ({ ...dns, lookup: async (hostname: string) => {
  console.error("SLOW_SYSTEM_DNS " + hostname);
  await Bun.sleep(6_000);
  throw Object.assign(new Error("getaddrinfo ENOTFOUND " + hostname), { code: "ENOTFOUND" });
}}));
''', encoding='utf-8', newline='\n')


def capture(name, command, timeout=20):
    home = tempfile.mkdtemp(prefix='ocx-proxy-control-')
    env = dict(os.environ, OPENCODEX_HOME=home)
    started = time.monotonic()
    process = subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, encoding='utf-8', errors='replace')
    timed_out = False
    try:
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            process.kill()
            stdout, stderr = process.communicate(timeout=5)
        result = {'returncode': process.returncode, 'timed_out': timed_out,
                  'seconds': time.monotonic() - started, 'stdout': stdout, 'stderr': stderr}
        (root / (name + '.json')).write_text(json.dumps(result, indent=2), encoding='utf-8')
        return result
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        shutil.rmtree(home, ignore_errors=True)


try:
    old = capture('slow-dns-baseline', ['bun', '--preload', './' + preload.as_posix(), baseline_path.as_posix()], 15)
    assert old['timed_out'], 'Baseline unexpectedly avoided the injected slow resolver: ' + json.dumps(old)
    assert 'SLOW_SYSTEM_DNS proxy-only.invalid' in old['stderr']
    new = capture('slow-dns-candidate', ['bun', '--preload', './' + preload.as_posix(), fixture.as_posix()], 15)
    assert not new['timed_out'] and new['returncode'] == 0, new
    assert 'SLOW_SYSTEM_DNS' not in new['stderr'], 'Candidate reached the external resolver seam'
    value = json.loads(new['stdout'])
    assert value['dnsLookups'] == ['proxy-only.invalid', 'connection-proxy.invalid', 'proxy-models.invalid', 'all-proxy-only.invalid']
    assert len(value['proxyRequests']) == 4 and len(value['providerRequests']) == 3
    fixture.write_text(candidate + '\nconsole.error("DIAGNOSTIC_CHILD_PID " + process.pid);\nsetInterval(() => {}, 1_000);\n', encoding='utf-8', newline='\n')
    hung = capture('hung-child-negative', ['bun', 'test', '--isolate', '--test-name-pattern',
                                         'proxy mode reaches one real proxy', 'tests/providers/provider-outbound.test.ts'], 20)
    assert not hung['timed_out'] and hung['returncode'] != 0, hung
    assert 'provider outbound fixture exited' in hung['stderr'], hung
    assert 'this test timed out' not in hung['stderr'], 'Outer deadline fired before fixture cleanup'
    match = re.search(r'DIAGNOSTIC_CHILD_PID (\d+)', hung['stderr'])
    assert match, 'Hung fixture did not reach the diagnostic hold'
    pid = match.group(1)
    probe = subprocess.run(['bun', '-e', f'try {{ process.kill({pid}, 0); process.exit(1); }} catch (error) {{ if (error.code !== "ESRCH") throw error; }}'], capture_output=True, text=True)
    assert probe.returncode == 0, 'Fixture process was not reaped: ' + probe.stderr
    (root / 'negative-controls-passed.txt').write_text(
        'Slow system DNS: baseline times out; candidate avoids the system resolver.\n'
        'Hung child: parent fails explicitly before the outer deadline, and the child is gone.\n', encoding='utf-8')
finally:
    fixture.write_text(candidate, encoding='utf-8', newline='\n')
    baseline_path.unlink(missing_ok=True)
