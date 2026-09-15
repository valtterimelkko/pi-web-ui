import { vi } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { installSystemctlGuard } from './systemctl-guard.js';

// A test run must not write production's restart record either (2026-09-15).
//
// Every repo-owned restart path now names its requester through
// scripts/record-restart-requester.sh, whose durable sink defaults to
// /root/.pi-web-ui/stop-audit.log. A suite that runs one of those paths without
// overriding the seam would otherwise append a false requester record to
// production's forensic file — polluting the very lane this work relies on. The
// default is therefore redirected for the whole test process; a suite that wants
// to assert on a record still sets the seam itself.
if (!process.env.PI_WEB_UI_STOP_AUDIT_FILE) {
  process.env.PI_WEB_UI_STOP_AUDIT_FILE = path.join(tmpdir(), `pi-web-ui-test-stop-audit-${process.pid}.log`);
}

// No test process may reach the host service manager (2026-09-15).
//
// A red-proof run `git stash`-ed scripts/restart-pi-web-ui.sh back to its
// pre-guard revision, which calls a bare `systemctl restart pi-web-ui`; the
// suite's interception lived in the code under test, so it vanished with it and
// production was restarted for real at 14:27:05Z. This guard is installed by the
// test environment instead, so no revision of any script a test runs can remove
// it: state-changing verbs are refused and recorded, read-only verbs pass
// through. See tests/systemctl-guard.ts.
installSystemctlGuard();

// Unit/integration subjects use explicit env fixtures, never a developer's
// on-disk .env. Keep parse() real for validation-env fixture tests. This does
// not alter the application loader or source/compiled live-validation mode.
vi.mock('dotenv', async (importOriginal) => {
  const original = await importOriginal<typeof import('dotenv')>();
  const config = () => ({ parsed: {} });
  return { ...original, config, default: { ...original.default, config } };
});
