#!/usr/bin/env python3
"""Conductor dispatch: create goal-armed pi children on zai/glm-5.3-flash and dispatch their briefs."""
import json, os, subprocess, sys, time

SOCKET = os.path.expanduser("~/.pi-web-ui/internal-api.sock")
TOKEN = open(os.path.expanduser("~/.pi-web-ui/internal-api-token")).read().strip()
BASE = "http://localhost/api/v1"
D = "/root/pi-web-ui/operations/change-requests-20260915/exec-2026-09-15"
PARENT = os.environ.get("PI_SESSION_ID", "01a0a455-0917-7729-9433-fcd8b4d7556d")


def api(method, path, body=None, timeout=60):
    cmd = ["curl", "-s", "--max-time", str(timeout), "--unix-socket", SOCKET,
           "-H", f"Authorization: Bearer {TOKEN}", "-H", "Content-Type: application/json",
           "-H", f"X-Parent-Session: {PARENT}", "-X", method, BASE + path]
    if body is not None:
        cmd += ["-d", json.dumps(body)]
    out = subprocess.run(cmd, capture_output=True, text=True)
    if out.returncode != 0:
        return {"_curl_error": out.stderr.strip()}
    try:
        return json.loads(out.stdout)
    except Exception:
        return {"_raw": out.stdout[:400]}


CHILDREN = [
    dict(tag="A", name="restart-path", cwd="/root/pi-web-ui-wt-restart",
         model="zai/glm-5.3-flash", thinking="high", max_turns=15),
    dict(tag="B", name="multi-lane", cwd="/root/pi-web-ui-wt-lanes",
         model="zai/glm-5.3-flash", thinking="max", max_turns=30),
    dict(tag="C", name="investigate", cwd="/tmp/wt-investigate",
         model="zai/glm-5.3-flash", thinking="high", max_turns=10),
]

os.makedirs("/tmp/wt-investigate", exist_ok=True)
records = {}
failures = []

for ch in CHILDREN:
    tag = ch["tag"]
    objective = open(f"{D}/objective-{tag}.txt").read().strip()
    brief = open(f"{D}/brief-{tag}.md").read()

    create = api("POST", "/sessions", {
        "runtime": "pi",
        "model": ch["model"],
        "thinkingLevel": ch["thinking"],
        "cwd": ch["cwd"],
        "retention": {"mode": "durable", "ttlSeconds": 28800,
                      "ownerId": f"conductor-20260915-{tag}"},
        "goal": {"objective": objective, "maxTurns": ch["max_turns"]},
    })
    sid = create.get("sessionId") or create.get("id")
    if not sid:
        failures.append((tag, "create failed", create))
        print(f"[{tag}] CREATE FAILED: {json.dumps(create)[:400]}")
        continue

    binding = create.get("modelBinding") or {}
    resolved = create.get("resolvedModel") or binding.get("resolvedModel") or binding.get("model")
    lease = (create.get("retention") or {}).get("leaseId")
    print(f"[{tag}] created {sid}")
    print(f"     requested={ch['model']} resolved={resolved} fallbackApplied={create.get('fallbackApplied')}")
    print(f"     thinking={ch['thinking']} lease={lease} parent={create.get('parentSessionId')}")

    if resolved and ch["model"].split("/")[-1] not in str(resolved):
        failures.append((tag, "model did not bind", create))
        print(f"[{tag}] !! MODEL BINDING MISMATCH — not dispatching")

    dispatch = api("POST", f"/sessions/{sid}/prompt", {
        "message": brief.replace("{{SID}}", sid),
        "verbosity": "answers",
        "detach": True,
    }, timeout=120)
    run_id = dispatch.get("runId")
    print(f"     dispatched runId={run_id} mode={dispatch.get('dispatchMode')} "
          f"error={dispatch.get('error') or dispatch.get('code') or ''}")

    records[tag] = dict(sessionId=sid, runId=run_id, cwd=ch["cwd"], model=ch["model"],
                        thinking=ch["thinking"], leaseId=lease, objective=objective,
                        resolvedModel=resolved, name=ch["name"])
    time.sleep(1)

with open(f"{D}/children.json", "w") as fh:
    json.dump(records, fh, indent=2)

print("\n=== SUMMARY ===")
for tag, r in records.items():
    print(f"  {tag}: {r['sessionId']}  run={r['runId']}  {r['thinking']}  {r['cwd']}")
if failures:
    print("\nFAILURES:")
    for f in failures:
        print(" ", f[0], f[1], json.dumps(f[2])[:300])
    sys.exit(1)
print("\nall children created and dispatched")
