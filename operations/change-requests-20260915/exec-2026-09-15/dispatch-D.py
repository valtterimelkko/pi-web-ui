#!/usr/bin/env python3
"""Conductor dispatch: child D — card identity + variant gate + contract 1.44.0 (wave 2)."""
import json, os, subprocess, sys
SOCKET=os.path.expanduser("~/.pi-web-ui/internal-api.sock")
TOKEN=open(os.path.expanduser("~/.pi-web-ui/internal-api-token")).read().strip()
BASE="http://localhost/api/v1"
D="/root/pi-web-ui/operations/change-requests-20260915/exec-2026-09-15"
PARENT=os.environ.get("PI_SESSION_ID","01a0a455-0917-7729-9433-fcd8b4d7556d")

def api(method,path,body=None,timeout=120):
    cmd=["curl","-s","--max-time",str(timeout),"--unix-socket",SOCKET,
         "-H",f"Authorization: Bearer {TOKEN}","-H","Content-Type: application/json",
         "-H",f"X-Parent-Session: {PARENT}","-X",method,BASE+path]
    if body is not None: cmd+=["-d",json.dumps(body)]
    o=subprocess.run(cmd,capture_output=True,text=True)
    try: return json.loads(o.stdout)
    except Exception: return {"_raw":o.stdout[:300],"err":o.stderr[:200]}

objective=open(f"{D}/objective-D.txt").read().strip()
brief=open(f"{D}/brief-D.md").read()

create=api("POST","/sessions",{
  "runtime":"pi","model":"zai/glm-5.3-flash","thinkingLevel":"max",
  "cwd":"/root/pi-web-ui-wt-card",
  "retention":{"mode":"durable","ttlSeconds":28800,"ownerId":"conductor-20260915-D"},
  "goal":{"objective":objective,"maxTurns":30},
})
sid=create.get("sessionId") or create.get("id")
if not sid:
    print("CREATE FAILED:",json.dumps(create)[:500]); sys.exit(1)
b=create.get("modelBinding") or {}
res=b.get("resolvedModel") or b.get("model") or create.get("resolvedModel")
print(f"created {sid}")
print(f"  requested=zai/glm-5.3-flash resolved={res} fallback={create.get('fallbackApplied')}")
print(f"  lease={(create.get('retention') or {}).get('leaseId')} parent={create.get('parentSessionId')}")
if res and "glm-5.3-flash" not in str(res):
    print("  !! binding mismatch — not dispatching"); sys.exit(1)

d=api("POST",f"/sessions/{sid}/prompt",{"message":brief.replace("{{SID}}",sid),"verbosity":"answers","detach":True})
print(f"  dispatched runId={d.get('runId')} mode={d.get('dispatchMode')} err={d.get('error') or d.get('code') or ''}")

rec=json.load(open(f"{D}/children.json"))
rec["D"]=dict(sessionId=sid,runId=d.get("runId"),cwd="/root/pi-web-ui-wt-card",model="zai/glm-5.3-flash",
              thinking="max",leaseId=(create.get("retention") or {}).get("leaseId"),objective=objective,
              resolvedModel=res,name="card-identity")
json.dump(rec,open(f"{D}/children.json","w"),indent=2)
open(f"{D}/D-sid.txt","w").write(sid)
print("  recorded in children.json")
