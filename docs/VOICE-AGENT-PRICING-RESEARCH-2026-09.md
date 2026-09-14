# Real Voice-Agent Pricing Research (September 2026)

> **Question.** The Artificial Analysis Speech Agent Arena tweet
> (<https://x.com/ArtificialAnlys/status/2090806900631994528>, 21 Aug 2026) ranks
> speech-to-speech (S2S) models. If we replaced Drive Mode's "voice workaround"
> stack (OpenAI STT + Gemma talker + OpenAI TTS) with a real voice model, what
> would the top models cost at **2 h/day of voice mode**?
>
> **Researched:** 2026-09-14. All prices from official provider pricing pages
> (OpenAI, Google, xAI, Alibaba, ElevenLabs, Deepgram, AWS, Inworld), the live
> Artificial Analysis speech-to-speech page, and the OpenRouter models API.
> This is a research record, not a plan — no code was changed.

---

## 1. The tweet — what it announced

Artificial Analysis launched the **Speech Agent Arena**: human participants
compare two hidden S2S models on the same scenario (15 agentic scenarios with
tool calls, 20 non-agentic), and vote. Outputs: **Preference Elo** and, for
agentic scenarios, **Task Success Rate (TSR)**.

Key results as tweeted (21 Aug 2026):

- **Preference Elo:** Gemini 3.1 Flash Live Preview – Minimal 1,046 · Gemini
  3.1 Flash Live – High 1,014 · GPT-Realtime-1.5 1,000 · GPT Realtime (Aug '25)
  944 · ElevenLabs Agents (cascaded: Scribe v2 Realtime / GPT-4o Mini /
  Eleven v3) 937.
- **Task Success Rate:** Grok Voice Think Fast 2.0 High 94.7% ·
  GPT-Realtime-2.1 High 91.5% · ElevenLabs Agents 90.5% · GPT-Realtime-2 (High)
  89.8%.
- **The catch:** Gemini Minimal leads preference but records only 74.6% TSR —
  "a preferred conversation does not always result in successful task
  completion."
- Faster time-to-first-audio correlates with preference (Gemini Minimal TTFA
  0.96 s).

## 2. Updated leaderboard (live AA site, 2026-09-14)

Overall-slice standings (full-run appearance counts) are materially unchanged
vs the tweet; Elo ordering has slightly reshuffled mid-table:

| # | Model | Elo | TSR |
|---|---|---:|---:|
| 1 | Gemini 3.1 Flash Live **Minimal** | 1,046 | 74.6% |
| 2 | Gemini 3.1 Flash Live **High** | 1,014 | 71.8% |
| 3 | GPT-Realtime-1.5 | 1,000 | 85.1% |
| 4 | GPT Realtime (Aug '25) | 944 | 89.4% |
| 5 | ElevenLabs Agents (Default Cascaded) | 937 | 90.5% |
| 6 | Nova 2.0 Sonic (Mar 2026) | 917 | 57.1% |
| 7 | GPT-Realtime-2 (High) | 914 | 89.8% |
| 8 | GPT Realtime Mini (Oct '25) | 912 | 79.6% |
| 9 | **Grok Voice Think Fast 2.0 High** | 908 | **94.7%** |
| 10 | GPT-Realtime-2.1 Minimal | 896 | 89.4% |
| 11 | GPT-Realtime-2.1 High | 892 | 91.5% |
| 12 | Deepgram Voice Agent (cascaded) | 882 | 73.7% |
| 13 | GPT-Realtime-2 (Minimal) | 881 | 84.7% |
| 14 | Nova Sonic | 852 | 57.1% |
| 15–20 | Qwen3.5 Omni Plus/Flash, GPT-RT-2.1 Mini, Inworld, Qwen Audio 3.0 Flash/Plus | 799–699 | 62–82% |

A newer, lower-appearance slice has Gemini High at 1,116 — Gemini is extending
its lead, not losing it. Grok Voice Think Fast 2.0 High remains the TSR leader
(94.7%) with the fastest TTFA on the board (0.70 s).

AA's own per-hour cost framing (benchmark-density, from the tweet): Gemini
Minimal **$1.50/h** input audio · Grok TF 2.0 **$4.80/h** · GPT-Realtime-2.1
High **$10.75/h**. Note: AA's "cost per hour of input audio" normalises a fixed
40-question benchmark to an hourly rate — it is an apples-to-apples comparison
metric, **not** the per-hour price of a continuously connected session. The
sections below use official per-token/ per-minute rates for our own maths.

## 3. What a real voice model would replace here

Current Drive Mode voice pipeline (inspected 2026-09-14):

| Stage | Today | File |
|---|---|---|
| STT (dictation) | OpenAI **gpt-4o-mini-transcribe** ($0.003/min) with speculative transcription + fallback | `server/src/dictation/stt.ts`, `server/src/routes/dictation.ts` |
| Talker lane (spoken conversation + relay + permission gate) | **google/gemma-4-26b-a4b-it** via OpenRouter ($0.09/$0.30 per 1M tok), thinking off, provider preference deepinfra/darkbloom/novita + degenerate-output retry | `server/src/talker/model-client.ts` |
| Turn digests (Headlines/Summary read-outs) | Same Gemma talker model | `server/src/talker/digest.ts`, `client/src/lib/turnDigest.ts` |
| TTS (read-aloud) | OpenAI **tts-1** ($15/1M chars) | `server/src/routes/tts.ts`, `server/src/config.ts` (`TTS_MODEL`) |
| Worker lane (the actual coding agent) | Claude Sonnet 5 / chosen model, ordinary session | untouched by this decision |

A single S2S voice model replaces **three of the four voice stages at once**:
STT, the Gemma talker, and TTS (and the turn-digest model calls, which become
native speech). It does **not** replace the worker lane — architecturally the
closest market analogue to our two-lane design is OpenAI's GPT-Live, which
explicitly "delegates reasoning and tool use to a backend agent."

## 4. Official API pricing (verified 2026-09-14)

| System | Official price | Source |
|---|---|---|
| **Gemini 3.1 Flash Live** (Minimal & High, same price) | Audio **$3.00/1M in · $12.00/1M out** (~25 tok/s ⇒ ~$0.005/min in, $0.018/min out); text $0.75/$4.50 per 1M | Google pricing (via official table reproduced by aibytes.blog; ai.google.dev gated) |
| **OpenAI gpt-realtime-2.1 / 2 / 1.5** | Audio **$32/1M in · $64/1M out**; text $4/$24. Billing: **1 token per 100 ms user audio, 1 per 50 ms assistant audio**; VAD excludes silence | platform.openai.com/docs/pricing.md + voice-latency-cost guide |
| **OpenAI gpt-realtime-2.1-mini** | Audio $10/1M in · $20/1M out | same |
| **OpenAI GPT-Live-1** | **$0.05/min, billed per second of session, silence included** (backend model billed separately). AA lists Sol/Astra voice variants at $4.47–5.83/h | developers.openai.com/api/docs/models/gpt-live-1 |
| **xAI grok-voice-think-fast-2.0** | **$0.08/min ($4.80/h) audio**; +$0.004 text input | docs.x.ai/docs/pricing |
| **ElevenLabs Agents** (hosted cascade) | **$0.08/min call time** ($0.16 burst); LLM + telephony extra. Components à la carte: Scribe v2 Realtime STT $0.39/h; Eleven v3 TTS $0.10/1k chars ($0.05 conversational) | elevenlabs.io/pricing/api + /pricing/agents |
| **Deepgram Voice Agent** | **$0.075/min** Standard ($0.056 promo ended 14 Sep); BYO-LLM $0.065/min; includes Deepgram STT+TTS, WebSocket connect-time billing | deepgram.com/pricing |
| **Amazon Nova 2 Sonic** | Audio **$3/1M in · $12/1M out** (same class as Gemini); text $0.33/$2.75 | AWS Bedrock pricing (values via cloudprice.net capture) |
| **Qwen Audio 3.0 Realtime Plus** | Audio **$6.40/1M in · $24/1M out**; text $0.80/$6.40 | Alibaba Model Studio model-pricing (intl) |
| **Qwen3.5 Omni Plus Realtime** | Audio $16.50/1M in · $62/1M out | same |
| **Inworld** (component-priced) | Realtime STT $0.15/h; TTS-2 Flash $15/1M chars (~1k chars ≈ 1 speech-min); LLM extra | inworld.ai/pricing |
| *Current:* gpt-4o-mini-transcribe | $0.003/min | OpenAI pricing.md |
| *Current:* tts-1 | $15/1M chars | OpenAI pricing.md |
| *Current:* gemma-4-26b-a4b-it (OpenRouter) | $0.09/1M in · $0.30/1M out | openrouter.ai/api/v1/models |

## 5. Cost model — 2 h/day voice mode (60 h/month)

Session profile assumed: user speaks ~20 min/h; voice layer speaks ~15 min/h;
the rest is silence / worker-lane work. Two billing shapes matter: **token-based
VAD-gated** models bill only actual speech; **session-billed** models bill the
whole connected time including silence while the worker crunches.

### What we pay today

| Stage | Monthly |
|---|---:|
| STT (gpt-4o-mini-transcribe, 1,200 speech-min) | $3.60 |
| TTS (tts-1, ~13.5k chars/h) | $12.15 |
| Gemma talker (~30 turns/h + digests) | $0.57 |
| **Total voice workaround stack** | **≈ $13/month ($0.21/h)** |

### Replacement options

| Option | Monthly (60 h) | $/h | vs today |
|---|---:|---:|---:|
| **Gemini 3.1 Flash Live Minimal** — VAD-gated | **$22** | $0.36 | **1.7×** |
| Gemini 3.1 Flash Live Minimal — continuous mic streaming | $32 | $0.54 | 2.5× |
| **gpt-realtime-2.1-mini** — VAD | $29 | $0.48 | 2.3× |
| Qwen Audio 3.0 Realtime Plus (25 tok/s assumed) | $44–67 | $0.73–1.12 | 3.4–5× |
| **gpt-realtime-2.1** (2/1.5 same) — VAD | $92 | $1.54 | 7× |
| **GPT-Live-1** — $0.05/min session (silence billed) | $180 | $3.00 | 14× |
| **Deepgram Voice Agent** Std (BYO-LLM $234) | $270 | $4.50 | 21× |
| **Grok Voice Think Fast 2.0 High** — $0.08/min | $288 | $4.80 | 22× |
| **ElevenLabs Agents** — $0.08/min + LLM | $288+ | $4.80+ | 22× |

OpenAI realtime detail: input 20 min/h × 10 tok/s = 12k tok/h → $23/month;
output 15 min/h × 20 tok/s = 18k tok/h → $69/month; cached-history resend
negligible ($0.40/1M). Grok/ElevenLabs/Deepgram figures assume billing tracks
the connected session; if Grok bills only active audio the true cost sits
somewhere below $288 — their published "$0.08/min audio" does not disambiguate,
so treat $288 as the safe upper bound.

### Bottom line

At 2 h/day, replacing the whole STT+Gemma+TTS workaround with a **top-quality
native voice model costs roughly $9–32/month more than today** if we pick the
market's preference leader (Gemini 3.1 Flash Live, ~$22–32 vs ~$13 today), and
roughly **$275/month more (≈22×)** if we pick the task-success or
platform-integration leaders (Grok TF 2.0 / ElevenLabs Agents), with OpenAI's
GPT-Live-1 in between at ~$180/month (≈14×) but with the simplest mental model:
flat $3/h for the voice layer, worker lane unchanged.

## 6. Analysis

1. **The arena's "task success" metric maps poorly onto our architecture.** In
   the arena, the S2S model itself makes the final tool call. In our two-lane
   design the voice model only converses and relays; the worker lane owns every
   action. Our candidate therefore needs *preference-grade conversation and
   faithful relay*, not agentic tool-call reliability — which favours **Gemini
   3.1 Flash Live Minimal** (Elo 1,046, TTFA 0.96 s) and de-emphasises Grok's
   94.7% TSR advantage.
2. **Latency fits.** Our talker requirement is ≤2 s to first token; Gemini
   Minimal measures 0.96 s TTFA, Grok 0.70 s, GPT-Realtime-2.1 1.21 s — all
   compliant. Gemma's first-token budget (≤2 s target, >4 s fail) is matched or
   beaten by the leaders.
3. **Cost ranking is stable across methodologies.** AA's benchmark-density
   $/hour and our official-rate streaming maths agree on the order:
   Gemini ≪ Qwen < OpenAI realtime < GPT-Live < Deepgram < Grok ≈ ElevenLabs.
4. **Cheap tier exists.** gpt-realtime-2.1-mini (~$29/month, 2.3×) and Qwen
   Audio 3.0 Realtime Plus are the budget S2S routes; Qwen's AA elo (699) is far
   below the leaders, the mini is unranked in the overall top 10.
5. **Voice cost is secondary to worker cost.** At 20 worker turns/day a Claude
   Sonnet-class worker lane already costs on the order of $50–150/month. Even
   the most expensive voice upgrade (~$288) is the same order of magnitude as
   the worker lane itself — and the mid options (Gemini at +$9–19/month) are
   rounding errors. The real reason to switch is latency, naturalness, and
   deleting the STT→text→talker→TTS cascade, not price.
6. **Caveats.** Gemini 3.1 Flash Live is preview (free tier available during
   preview per Google's announcement); preview APIs churn. Gemini/Nova/Qwen
   audio-token densities are assumed 25 tok/s (Google's documented Live rate);
   a different density for Nova/Qwen would move those rows proportionally.
   Finnish capability (our talker's secondary language) is unverified for Grok
   and Qwen; Gemini and OpenAI are known-strong. ElevenLabs Agents additionally
   bills the cascade LLM separately.

## 7. Sources

- Tweet: <https://x.com/ArtificialAnlys/status/2090806900631994528> (fetched via TwitterAPI.io, full text + author follow-ups)
- Live leaderboard + per-model TTFA/cost data: <https://artificialanalysis.ai/speech-to-speech> (embedded dataset, 2026-09-14)
- OpenAI: <https://platform.openai.com/docs/pricing.md>, <https://developers.openai.com/api/docs/models/gpt-live-1.md>, voice-latency-cost guide
- xAI: <https://docs.x.ai/docs/pricing>, <https://docs.x.ai/docs/models>
- Google: Vertex AI pricing page (2.5 Flash Live, token rates); Gemini 3.1 Flash Live table via aibytes.blog reproduction of ai.google.dev pricing
- ElevenLabs: elevenlabs.io/pricing/api, elevenlabs.io/pricing/agents
- Deepgram: deepgram.com/pricing; AWS: aws.amazon.com/bedrock/pricing (+cloudprice.net capture); Alibaba: alibabacloud.com Model Studio model-pricing; Inworld: inworld.ai/pricing
- OpenRouter models API (gemma-4-26b-a4b-it pricing)
- Companion subagent report (ElevenLabs/Nova/Deepgram/Inworld/Qwen verification), 2026-09-14
