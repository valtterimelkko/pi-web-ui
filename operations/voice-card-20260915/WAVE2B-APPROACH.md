# WAVE 2b approach — live validation of the card contract (parent note, 2026-09-15)

Disposable server only (`npm run validate:server`); never production, never a restart.

## Why a local talker stub is the right model for this seam

The card payload is produced on the **WebSocket seam** (`connection.ts` →
`talker_turn_result.proposal`), and the release variant is consumed by the server's
gate (`talker.ts` → `pending-proposal.takeForRelease`). Both need a *proposed*
turn, and a statement only joins the draft after a model turn, so the disposable
server needs a talker model configured — otherwise every statement turn refuses
with `model_unconfigured` and no proposal exists to inspect.

The talker client is OpenAI-compatible and fully env-configurable
(`server/src/talker/model-client.ts`):
`TALKER_BASE_URL` (default `https://openrouter.ai/api/v1`), `TALKER_API_KEY`,
`TALKER_MODEL` (default `google/gemma-4-26b-a4b-it`).

So run a **local deterministic stub** on 127.0.0.1 that answers
`POST /v1/chat/completions` with a fixed non-marker reply, and point the
disposable server at it. Zero cost, byte-deterministic, no external calls — and it
still exercises the real WS handler, the real registry, the real gate and the real
`proposal` payload. `scripts/validation-server.ts` already supports passing extra
env to the child (`--env-file` / `--env-key`).

Rows to drive (real `POST /sessions` pi worker session created on the disposable
server so the lane has a delivery target):

1. **Invisible tidy** — utterance ending in a newline (and one with a double
   space): expect `cleaned:false`, no `removed`, no `original`; relay text
   normalised; the card would say "exactly".
2. **Visible tidy** — e.g. `"Okay, um, rebase the branch please"`: expect
   `cleaned:true`, `removed` carrying only the fragments, `original` = the raw
   utterance.
3. **Default release** — confirm: `released.text` byte-identical to
   `proposal.text`.
4. **Original release** — confirm with `releaseVariant:"original"`:
   `released.text` byte-identical to `proposal.original`.
5. **Gate untouched** — a non-confirm utterance carrying
   `releaseVariant:"original"` must not release (drafts as usual);
   nothing-pending and lapsed-draft behaviour unchanged.
6. **Transport regression** — `scripts/p27-ws-transport-validate.mjs` and
   `scripts/p27-talker-matrix-live.ts --stub-only` still pass.

Evidence: the observed bytes per row (payload JSON + released text), the raw
server log excerpt, and the command that produced each row.
