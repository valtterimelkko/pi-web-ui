#!/usr/bin/env python3
"""E2a-5 arm 3 — Playwright oracle for the hb2 + hb6 claims, run DURING the H1
burst (shared server, shared lock window).

Claims under re-test (executor reports are claims, not facts):
  hb2: a browser watching a session the API prompts renders the first streamed
       chunk ONCE (no doubled first chunk in the DOM).
  hb6: one user bubble per typed prompt; a queued (steer) chip appears while
       streaming and CLEARS at settle (hb6 correction 02).
Plus: no console errors.

Flow per viewport (desktop 1440x900 first, then mobile 390x844):
  1. open the app via the vite dev client, log in, watch child session #0
     (search by label, click) — the child is RESIDENT and streaming;
  2. API-prompt the child; assert the streamed reply renders exactly once and
     matches the on-disk transcript's final assistant text (doubled variant absent);
  3. type prompt T1 in the composer; while it streams type T2 (queue/steer →
     chip seen); assert chip seen during streaming;
  4. settle; assert: chip count 0, DOM occurrences T1 == 1, T2 == 1 (excluding
     the chip), transcript holds T1 and T2, and the last assistant text matches
     the transcript exactly;
  5. screenshots before/after/during/settled + Playwright trace; console error
     sweep for the whole session.

Usage: browser-check.py --run-dir=<dir> [--viewport=desktop|mobile|both]
Outputs JSON verdict to <run-dir>/browser-check-result.json (+ per-viewport keys)
and screenshots under /root/e2a-runs/a5/screens/.
"""
import json
import os
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

args = {}
for a in sys.argv[1:]:
    if a.startswith('--'):
        k, _, v = a[2:].partition('=')
        args[k] = v if v else 'true'

RUN = Path(args['run-dir']).resolve()
VIEWPORT = args.get('viewport', 'both')
SCREENS = Path('/root/e2a-runs/a5/screens')
SCREENS.mkdir(parents=True, exist_ok=True)
BASE = os.environ.get('A5_VITE_BASE', 'http://127.0.0.1:3457')
SOCKET = str(RUN / 'server' / 'internal-api.sock')
TOKEN = (RUN / 'server' / 'internal-api-token').read_text().strip()
MARKER = os.environ.get('A5_BROWSER_MARKER') or f"A5BR-{int(time.time())}"
SMOKE = args.get('smoke') == 'true'
CHILDREN = None if SMOKE else json.loads((RUN / 'children.json').read_text())
CHILD = CHILDREN[0] if CHILDREN else None  # the browser watches child #0

VIEWPORTS = {
    'desktop': dict(viewport={'width': 1440, 'height': 900}),
    'mobile': dict(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, device_scale_factor=2),
}
LABEL = 'goal'  # child #0's workspace dir name fragment used in search


def api(method, path_, body=None, timeout=300):
    import subprocess
    payload = json.dumps(body) if body is not None else None
    cmd = ['curl', '-s', '--max-time', str(timeout), '--unix-socket', SOCKET, '-X', method,
           '-H', f'authorization: Bearer {TOKEN}', '-H', 'content-type: application/json']
    if payload is not None:
        cmd += ['-d', payload]
    cmd += [f'http://localhost{path_}']
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 10).stdout


def transcript_entries(path_str):
    """Parsed JSONL entries of the child's session file."""
    p = Path(path_str)
    if not p.exists():
        return []
    out = []
    for line in p.read_text().strip().split('\n'):
        try:
            out.append(json.loads(line))
        except Exception:
            pass
    return out


def final_assistant_text(entries):
    texts = []
    for e in entries:
        if e.get('type') == 'message' and e.get('message', {}).get('role') == 'assistant':
            content = e['message'].get('content')
            if isinstance(content, list):
                texts.append(''.join(p.get('text', '') for p in content if isinstance(p, dict)))
            elif isinstance(content, str):
                texts.append(content)
    return texts[-1] if texts else None


def transcript_has(entries, needle):
    return any(needle in json.dumps(e) for e in entries)


def doubled_present(rendered, full):
    """Any non-empty prefix of `full` repeated immediately before `full`."""
    for ln in range(1, min(64, len(full)) + 1):
        if full[:ln] + full in rendered:
            return True
    return False


def console_baseline(errors, http_problems):
    """The app's cold-load /api/auth/me probe returns 401 before login
    (pre-existing behaviour at this build); Chromium logs it as one generic
    resource-load console error. That pair is the known baseline; everything
    else is a finding. Returns (unexpectedConsoleErrors, unexpectedHttpProblems)."""
    expected = [p for p in http_problems
                if p['url'].split('?')[0].endswith('/api/auth/me') and p['status'] in (401, 404)]
    unexpected_problems = [p for p in http_problems if p not in expected]
    if expected and not unexpected_problems:
        unexpected_errors = [e for e in errors if not e.startswith('Failed to load resource')]
    else:
        unexpected_errors = list(errors)
    return unexpected_errors, unexpected_problems


def dom_occurrences(page, needle):
    return page.evaluate(
        """(needle) => {
          const root = document.querySelector('[data-testid="chat-interface"]');
          if (!root) return -1;
          const clone = root.cloneNode(true);
          clone.querySelectorAll('[data-testid="streaming-queue"]').forEach((n) => n.remove());
          return (clone.textContent || '').split(needle).length - 1;
        }""", needle)


def chat_last_assistant_text(page):
    """Best-effort: the chat interface's full text; the exact-match assertion
    uses containment of the transcript text inside it (the transcript text is
    unique per marker)."""
    root = page.locator('[data-testid="chat-interface"]')
    return root.inner_text() if root.count() else ''


def shoot(page, name):
    out = SCREENS / name
    page.screenshot(path=str(out), full_page=False)
    print(f'screenshot: {out}', flush=True)


def open_child_session(page, seed_needle):
    page.goto(BASE)
    page.wait_for_load_state('networkidle')
    if page.locator('input[type="password"]').count() > 0:
        page.locator('input[type="password"]').fill('dev-password')
        page.locator('button[type="submit"]').first.click()
        page.wait_for_load_state('networkidle')
    deadline = time.time() + 30
    while time.time() < deadline and page.locator('[role="listitem"]').count() == 0:
        time.sleep(1)
    search = page.locator('input[aria-label="Search sessions"]').first
    search.fill(LABEL)
    page.wait_for_timeout(1200)
    rows = page.locator('[role="listitem"]')
    assert rows.count() >= 1, 'child session row not found in sidebar'
    rows.first.click()
    page.wait_for_timeout(3000)
    if VIEW != 'desktop':
        close_drawer(page)
    body = page.locator('body').inner_text()
    assert seed_needle in body, f'child transcript not visible after open ({VIEW})'


def close_drawer(page):
    for attempt in range(4):
        try:
            sv = page.locator('input[aria-label="Search sessions"]').first.is_visible()
        except Exception:
            sv = False
        if not sv:
            return
        if attempt % 2 == 0:
            page.keyboard.press('Escape')
            page.wait_for_timeout(700)
        else:
            try:
                page.mouse.click(320, 400)
                page.wait_for_timeout(700)
            except Exception:
                pass


def run_viewport(pw, view, results):
    view_results = {'viewport': view, 'consoleErrors': [], 'pageErrors': [], 'httpProblems': []}
    browser = pw.chromium.launch(headless=True)
    ctx = browser.new_context(**VIEWPORTS[view])
    ctx.tracing.start(screenshots=True, snapshots=True, sources=True)
    page = ctx.new_page()
    page.on('console', lambda m: view_results['consoleErrors'].append(m.text[:300]) if m.type == 'error' else None)
    page.on('pageerror', lambda e: view_results['pageErrors'].append(str(e)[:300]))
    page.on('response', lambda r: view_results['httpProblems'].append({'status': r.status, 'url': r.url[:200]}) if r.status >= 400 else None)
    tag = f'a5-{MARKER}-{view}'

    # ── 1. watch the child (resident, streaming) ────────────────────────────
    entries_before = transcript_entries(CHILD['sessionPath'])
    seed_needle = 'goal' if entries_before else 'goal'
    open_child_session(page, 'goal')

    # ── 2. API prompt → first streamed chunk exactly once (hb2) ─────────────
    live_marker = f'{MARKER}-API-{view.upper()}'
    resp = api('POST', f"/api/v1/sessions/{CHILD['sessionId']}/prompt",
               {'message': f'Reply with exactly one line: {live_marker} and nothing else.'})
    print(f'api prompt sent ({view}): {resp[:80].strip()}', flush=True)
    deadline = time.time() + 120
    while time.time() < deadline and live_marker not in Path(CHILD['sessionPath']).read_text():
        time.sleep(1)
    time.sleep(3)  # let the render settle
    entries_after = transcript_entries(CHILD['sessionPath'])
    final_text = final_assistant_text(entries_after)
    assert final_text and live_marker in final_text, f'transcript missing live marker ({view}): {final_text!r}'
    chat_text = chat_last_assistant_text(page)
    occurrences = chat_text.count(final_text)
    dbl = doubled_present(chat_text, final_text)
    view_results['hb2'] = {'transcriptFinal': final_text, 'domOccurrences': occurrences, 'doubledFound': dbl,
                           'ok': occurrences == 1 and not dbl}
    shoot(page, f'{tag}-02-after-api-prompt.png')

    # ── 3.+4. two typed prompts + one queued chip (hb6 + correction 02) ─────
    t1 = f'Say exactly: {MARKER}-T1-{view.upper()}'
    t2 = f'Say exactly: {MARKER}-T2-{view.upper()}'
    ta = page.locator('textarea[placeholder*="Ask anything"]').first
    ta.click(); ta.fill(t1); page.keyboard.press('Enter')
    time.sleep(1.0)
    ta.click(); ta.fill(t2); page.keyboard.press('Enter')
    chip_seen = False
    deadline = time.time() + 15
    while time.time() < deadline:
        if page.locator('[data-testid="streaming-queue"]').count() > 0:
            chip_seen = True
            break
        time.sleep(0.2)
    shoot(page, f'{tag}-03-during-queued.png')
    deadline = time.time() + 150
    file_path = Path(CHILD['sessionPath'])
    while time.time() < deadline and not (f'{MARKER}-T1-{view.upper()}' in file_path.read_text()
                                          and f'{MARKER}-T2-{view.upper()}' in file_path.read_text()):
        time.sleep(1)
    time.sleep(5)  # settle: run end + chip effects
    chips = page.locator('[data-testid="streaming-queue"]').count()
    d1 = dom_occurrences(page, t1)
    d2 = dom_occurrences(page, t2)
    f_ok = (f'{MARKER}-T1-{view.upper()}' in file_path.read_text()
            and f'{MARKER}-T2-{view.upper()}' in file_path.read_text())
    entries_final = transcript_entries(CHILD['sessionPath'])
    final2 = final_assistant_text(entries_final)
    chat_text2 = chat_last_assistant_text(page)
    occ2 = chat_text2.count(final2) if final2 else -1
    dbl2 = doubled_present(chat_text2, final2) if final2 else True
    view_results['hb6'] = {
        'chipSeenDuringStreaming': chip_seen, 'chipsAtSettle': chips,
        'domT1': d1, 'domT2': d2, 'transcriptHasT1T2': f_ok,
        'finalAssistant': {'domOccurrences': occ2, 'doubledFound': dbl2},
    }
    # Console-error baseline: the cold-load /api/auth/me 401 probe logs one
    # generic resource-load error on every page load (pre-existing at this
    # build); anything else — or any other >=400 response — is a finding.
    view_results['consoleErrorsUnexpected'], view_results['httpProblemsUnexpected'] = \
        console_baseline(view_results['consoleErrors'], view_results['httpProblems'])
    view_results['ok'] = bool(
        view_results['hb2']['ok'] and chip_seen and chips == 0 and d1 == 1 and d2 == 1
        and f_ok and occ2 == 1 and not dbl2
        and not view_results['pageErrors']
        and not view_results['consoleErrorsUnexpected']
        and not view_results['httpProblemsUnexpected']
    )
    shoot(page, f'{tag}-04-settled.png')
    trace_path = SCREENS / f'{tag}-trace.zip'
    ctx.tracing.stop(path=str(trace_path))
    view_results['trace'] = str(trace_path)
    ctx.close()
    browser.close()
    print(f'VERDICT {view}: ok={view_results["ok"]} hb2={view_results["hb2"]} hb6={view_results["hb6"]} '
          f'consoleErrors={len(view_results["consoleErrors"])} unexpected={len(view_results["consoleErrorsUnexpected"])} '
          f'httpProblems={view_results["httpProblemsUnexpected"]} pageErrors={len(view_results["pageErrors"])}', flush=True)
    return view_results


results = {'marker': MARKER, 'child': CHILD['sessionId'] if not SMOKE else None, 'viewports': {}, 'startedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
exit_code = 0


def run_smoke(pw, view):
    """Smoke mode: app opens, login works, sidebar renders, no unexpected
    console/page errors. The app's cold-load /api/auth/me probe returns 401
    before login (pre-existing behaviour at this build) and Chromium logs that
    response as one generic resource-load console error — recorded as the
    known baseline, not a finding; any OTHER >=400 response or console error
    fails the check."""
    vr = {'viewport': view, 'consoleErrors': [], 'pageErrors': [], 'httpProblems': []}
    browser = pw.chromium.launch(headless=True)
    ctx = browser.new_context(**VIEWPORTS[view])
    page = ctx.new_page()
    page.on('console', lambda m: vr['consoleErrors'].append(m.text[:300]) if m.type == 'error' else None)
    page.on('pageerror', lambda e: vr['pageErrors'].append(str(e)[:300]))
    page.on('response', lambda r: vr['httpProblems'].append({'status': r.status, 'url': r.url[:200]}) if r.status >= 400 else None)
    page.goto(BASE)
    page.wait_for_load_state('networkidle')
    if page.locator('input[type="password"]').count() > 0:
        page.locator('input[type="password"]').fill('dev-password')
        page.locator('button[type="submit"]').first.click()
        page.wait_for_load_state('networkidle')
    deadline = time.time() + 40
    while time.time() < deadline and page.locator('[role="listitem"]').count() == 0:
        time.sleep(1)
    vr['sessionRows'] = page.locator('[role="listitem"]').count()
    vr['consoleErrorsUnexpected'], vr['httpProblemsUnexpected'] = console_baseline(vr['consoleErrors'], vr['httpProblems'])
    vr['ok'] = vr['sessionRows'] > 0 and not vr['consoleErrorsUnexpected'] and not vr['pageErrors'] and not vr['httpProblemsUnexpected']
    SCREENS.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(SCREENS / f'a5-smoke-{view}.png'), full_page=False)
    ctx.close()
    browser.close()
    print(f'SMOKE {view}: rows={vr["sessionRows"]} consoleErrors={len(vr["consoleErrors"])} '
          f'unexpected={len(vr["consoleErrorsUnexpected"])} httpProblems={vr["httpProblemsUnexpected"]} ok={vr["ok"]}', flush=True)
    return vr


with sync_playwright() as pw:
    views = ['desktop', 'mobile'] if VIEWPORT == 'both' else [VIEWPORT]
    for view in views:
        try:
            results['viewports'][view] = run_smoke(pw, view) if SMOKE else run_viewport(pw, view, results)
        except Exception as e:
            results['viewports'][view] = {'ok': False, 'error': str(e)[:500]}
            exit_code = 1
results['ok'] = all(v.get('ok') for v in results['viewports'].values())
if not results['ok']:
    exit_code = 1
(RUN / 'browser-check-result.json').write_text(json.dumps(results, indent=1) + '\n')
print(f'BROWSER CHECK overall ok={results["ok"]} → {RUN}/browser-check-result.json', flush=True)
sys.exit(exit_code)
