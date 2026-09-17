# Real Voice-Agent Pricing Research (September 2026)

> **Class:** research record (not a plan, not a proposal). **Status:** current as research; superseded in places by its own §8 Gemini-launch and §9 gap-analysis addenda. **Last verified:** 2026-09-17. **Corpus:** Voice Mode — see [`VOICE-MODE-INDEX.md`](./VOICE-MODE-INDEX.md).

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
>
> **Addendum 2026-09-15:** Google launched **Gemini 3.8 Live** and **Gemini
> 3.8 Live Extended Thinking** the day after this research was written. §8
> records the announcement, Google's product facts, Artificial Analysis's
> first measurements, and the official pricing (confirmed identical to
> 3.1 Flash Live). §§1–7 stand except where §8 notes otherwise.
>
> **Gap analysis added 2026-09-16:** §9 is a different question against the
> same evidence base — *what is Voice Mode missing compared with what people
> generally look for in a voice agent?* It is verified against the shipped
> implementation, and its §9.4 extends §8.6's standing swap decision with a
> constraint §§1–8 did not name. §§1–8 stand unchanged.

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

---

## 8. Addendum (2026-09-15): Gemini 3.8 Live & Gemini 3.8 Live Extended Thinking

Google launched two successors to Gemini 3.1 Flash Live on 15 Sep 2026, the
day after this research was first written. This addendum records the
announcement, Google's product documentation, Artificial Analysis's first
measurements, and the official pricing.

### 8.1 The announcement

**Artificial Analysis tweet** (15 Sep 2026, 21:44 UTC):
<https://x.com/ArtificialAnlys/status/2099977679307243773> — AA's launch-day
evaluation of both models via the Gemini Live API (952 likes / 93 RT / ~95k
views at fetch time). Key takeaways as tweeted:

- **Speech to Speech Index:** Gemini 3.8 Live Extended Thinking (High) debuts
  **#1 at 82.6**, ahead of GPT-Live-1 (Astra, medium) 81.5, Grok Voice Think
  Fast 2.0 High 81.3 and GPT-Live-1 (Sol, low) 80.1. Standard **Gemini 3.8
  Live debuts #5 at 76.0** — both variants up on Gemini 3.1 Flash Live High
  at 71.5 (**+11.1 and +4.5 points**). The Index averages Speech Reasoning
  (Big Bench Audio), Agentic Performance (τ-Voice), Arena Preference and
  Arena Task Success Rate.
- **Speech Agent Arena:** 3.8 Live ranks **#2 in preference at Elo 1083**
  (behind Gemini 3.1 Flash Live at 1096, ahead of GPT-Live-1 Sol at 1053) and
  **#2 on Task Success Rate at 93.2%** (behind Grok Voice Think Fast 2.0 High
  at 94.6%). Extended Thinking (High) trails at Elo 990 with 89.1% TSR.
- **τ-Voice (agentic):** ET takes the **top spot at 68.6%** — up from 37.7%
  for 3.1 Flash Live High (+30.9 points) — ahead of GPT-Live-1 Astra 67.9%,
  Sol 59.3%, Grok 56.5%. The standard 3.8 Live scores just **30.1%**.
- **Big Bench Audio (reasoning):** ET **97.7%** (behind Qwen Audio 3.0
  Realtime Plus 99.2%, ahead of Grok TF 2.0 at 97.2%); standard 91.7%.
- **Speed:** average TTFA on Big Bench Audio is **1.18 s** (standard) and
  **1.35 s** (ET High) vs **2.99 s** for 3.1 Flash Live High — in line with
  GPT-Live-1 (Sol 1.24 s, Astra 1.34 s), behind Grok at 0.70 s.
- **Cost (AA benchmark-hour):** 3.8 Live **$0.84 per hour of input audio —
  the cheapest model in the Index and roughly half the $1.75 of 3.1 Flash
  Live High**. ET is **$3.50/h** — cheaper than GPT-Live-1 Sol ($4.47), Grok
  ($4.80), Astra ($5.83), and ~3.1× cheaper than GPT-Realtime-2.1 High
  ($10.75).

**Google's announcement** (blog.google, 15 Sep 2026, Tom Ouyang & Malini
Jaganathan): "our most advanced live dialogue models yet". 3.8 Live is
"built for scale and cost efficiency"; ET "built for high-complexity tasks,
with increased intelligence and multi-step reasoning". Google's own quoted
numbers match AA's (82.6 index #1, 68.6% τ-Voice, 35.1% on Sierra's
τ-Voice-banking, 97.7% Big Bench Audio; #2 Speech Agent Arena) and it adds a
claim of pushing the Pareto frontier on ServiceNow's EVA-Bench voice-agent
benchmark. Wider day-one coverage: SiliconANGLE, 9to5Google, Android
Authority.

### 8.2 What Google actually shipped (product facts)

**Lineage.** Per the DeepMind model card (15 Sep 2026), both models are
**based on Gemini 3 Pro** with native audio I/O — a Pro-lineage live model,
not a Flash refresh. 128K context in / 64K out; **knowledge cutoff January
2025**; known limitations include hallucinations and "occasional slowness or
timeout issues"; Frontier Safety assessment found no Tracked/Critical
Capability Levels.

**The two-model split** (model docs, both stable — no `-preview` suffix):

- `gemini-3.8-live` — "the default option for most low-latency voice agent
  experiences"; interleaved reasoning, but `thinking_level` is **not
  configurable** (must be omitted; migration note from 3.1).
- `gemini-3.8-live-extended-thinking` — background reasoning + asynchronous
  tool calls while audio keeps streaming; `thinking_level` **low / medium /
  high** (**MINIMAL unsupported**); function calling is **async
  NON_BLOCKING only** (blocking mode returns a hard error); no function
  scheduling.

**Capability headlines (both models):**

- **Asynchronous function calling** as the new default: tools/API calls run
  in the background while the conversation continues (3.8 Live keeps
  synchronous BLOCKING mode for compatibility, with SILENT / WHEN_IDLE /
  INTERRUPTED scheduling).
- **Near real-time visual grounding** — live visual input joins the
  conversation. Cost-relevant: default turn coverage is
  `TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO`, i.e. **video frames are sent
  (and billed) by default**; send frames only when needed.
- **97 supported languages** with automatic mid-conversation language
  switching and accent consistency.
- **Alphanumeric precision** for confirmation codes, claim numbers and
  technical strings.
- **Incremental client content updates** — structured data merged into the
  live session throughout its lifecycle.
- **Proactive audio permanently enabled** (disabling returns an error);
  **affective dialogue removed** vs 3.1 (`enable_affective_dialog` must be
  deleted).
- ET conversational UX: early verbal acknowledgements ("Let me check
  that…") and live progress narration while background tasks run. A new
  `interaction_status` field (**IN_PROGRESS / IDLE**) replaces `turnComplete`
  as the idle signal — clients must keep listening after `turnComplete:
  true` because background reasoning/tool calls may still follow.

**Other limits (model docs):** 131,072 input / 65,536 output tokens; search
grounding supported; not supported: caching, code execution, structured
outputs, URL context, Maps grounding, image generation, Batch API.

**Availability:** Gemini API + Google AI Studio (both models, day one, free
tier included); Search Live (3.8 Live); Gemini Live app and Workspace
Docs/Gmail/Keep Live for Google AI subscribers (ET); Gemini Enterprise
private preview for both. Platform integrations: Agora, Fishjam, LangChain,
LiveKit, Pipecat, Vercel, Vision Agents. Named customers: Salesforce,
Genspark, Lumeris. All generated audio carries a **SynthID** watermark.

### 8.3 Artificial Analysis measurements (live table, 2026-09-15)

Full metric rows fetched from <https://artificialanalysis.ai/speech-to-speech>:

| Model (provider) | S2S Index | Speech Reasoning | Conv. Dynamics | Agentic (τ-Voice) | Arena Elo | TSR | TTFA | Cost/h (benchmark) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **Gemini 3.8 Live ET (High)** | **82.6 (#1)** | 97.7% | 91.9% | **68.6% (#1)** | 990 | 89.1% | 1.35 s | **$3.50** |
| GPT-Live-1 (Astra, medium) | 81.5 | 90% | 94.9% | 67.9% | 1,048 | 87.4% | 1.34 s | $5.83 |
| **Grok Voice Think Fast 2.0 High** | 81.3 | 97.2% | 95.1% | 56.5% | 1,011 | **94.6% (#1)** | **0.70 s (#1)** | $4.80 |
| GPT-Live-1 (Sol, low) | 80.1 | 89% | **97.3% (#2)** | 59.3% | 1,053 | 90.9% | 1.24 s | $4.47 |
| **Gemini 3.8 Live** | **76.0 (#5)** | 91.7% | 96.1% (#5) | 30.1% | **1,083 (#2)** | 93.2% (#2) | 1.18 s | **$0.84 (cheapest)** |
| GPT-Realtime-2.1 High | 73.9 | 96% | 95.7% | 45.7% | 928 | 91.5% | 1.21 s | $10.75 |
| Gemini 3.1 Flash Live High (incumbent) | 71.5 | ~97% | 74.3% | 37.7% | 1,063 | 71.8% | 2.99 s | $1.75 |
| Gemini 3.1 Flash Live Minimal (incumbent) | 63.9 | 71% | 72.3% | 26.2% | 1,096 | 74.6% | 0.96 s | $1.50 |

Reading notes:

- **Elo drifts as arena votes accumulate** (the live table shows 3.1 Minimal
  1,096 / High 1,063; §2's 14 Sep snapshot had 1,046/1,014 — AA also freezes
  each model's Elo for Index purposes at first publication). 3.8 Live's debut
  1,083 sits between the two 3.1 variants; **no Gemini variant has yet
  displaced 3.1 Minimal as the human-preference leader** — Google's "second
  place in the Speech Agent Arena" claim is consistent with this.
- The standard/ET split is real, not marketing: standard 3.8 Live wins
  speed/cost/conversation but its τ-Voice (30.1%) is the weakest of any
  leader; ET flips agentic performance (68.6%, #1) while giving up ~93 Elo of
  conversational preference (1,083 → 990) and 4.1 points of TSR.
- On AA's FAQ aggregates: ET's 97.7% Big Bench Audio is #4 of 39 models
  (StepAudio 3 Realtime 99.7%, Qwen RT Plus 99.2%, Qwen3.5 Omni Plus 98.7%
  ahead); 3.8 Live's 96.1% conversational dynamics is #5 of 33.

### 8.4 Official pricing — confirmed identical to 3.1 Flash Live

Google's pricing page lists **gemini-3.8-live,
gemini-3.8-live-extended-thinking and gemini-3.1-flash-live-preview in a
single shared table** (verified 2026-09-15):

| Tier | Free tier | Paid (per 1M tokens) |
|---|---|---|
| Text input | free | $0.75 |
| **Audio input** | free | **$3.00 (= $0.005/min)** |
| Image/video input | free | $1.00 (= $0.002/min) |
| Text output | free | $4.50 |
| **Audio output (incl. thinking tokens)** | free | **$12.00 (= $0.018/min)** |

- The developers-blog footnote confirms the per-minute figures derive from
  the same $3/1M-in · $12/1M-out token rates as 3.1 Flash Live: **§4's Gemini
  row now covers all three models unchanged**, exactly as anticipated.
- **Extended Thinking's reasoning tokens are billed as output** (the table
  line reads "including thinking tokens"; SiliconANGLE independently: ET
  "also charges for reasoning tokens and for additional inputs such as video
  and documents"). AA's $3.50/h vs $0.84/h gap is therefore **thinking-token
  burn, not a rate difference** — at identical token rates 3.8 Live simply
  burns ~2× fewer total tokens per fixed benchmark-hour than 3.1 did.
- Free tier: **both new models are free of charge** (input and output) on the
  standard tier — the "free tokens" in launch coverage is the standing free
  tier, same shape as 3.1 Flash Live's preview free tier.
- Search grounding: 5,000 free requests/month shared across Gemini 3.x
  models, then $14 per 1,000 requests.
- **Our 2 h/day cost model (§5) is unchanged in price terms**: a Gemini
  native-S2S swap still lands at ≈$22–32/month vs ≈$13 today. What changes is
  quality per dollar (§8.6).

### 8.5 What each model is good at / weak at

**Gemini 3.8 Live (standard)**

- *Good:* cheapest frontier S2S under both methodologies ($0.84/h AA
  benchmark-hour; $3/$12 official rates); 2.5× faster than 3.1 High to first
  audio (1.18 s — inside our ≤2 s talker budget); conversational dynamics
  96.1%, a huge jump from 3.1's 74.3%; #2 preference Elo (1,083) and #2 TSR
  (93.2%); native async tool calls, visual grounding, 97 languages,
  alphanumeric precision; stable (non-preview) model string.
- *Weak:* agentic τ-Voice 30.1% — it should not be trusted to *own*
  multi-step tool workflows itself (our worker lane owns actions anyway);
  thinking effort not configurable; knowledge cutoff Jan 2025; caching not
  supported.

**Gemini 3.8 Live Extended Thinking**

- *Good:* #1 Speech to Speech Index (82.6); #1 τ-Voice agentic completion
  (68.6%, +30.9 points over 3.1 High); 35.1% on Sierra's τ-Voice-banking
  (Google-cited); 97.7% Big Bench Audio (#4 overall); configurable effort
  (low/med/high); narrates progress while working; still cheaper per
  benchmark-hour than every non-Google frontier rival ($3.50 vs $4.47–10.75).
- *Weak:* conversational preference drops below both 3.1 variants and
  GPT-Live-1 (Elo 990), and plain-conversation TSR trails the standard model
  (89.1% vs 93.2%) — visible thinking costs likability and a little
  reliability when no task is running; async-only function calling (breaking
  vs 3.1 patterns); MINIMAL effort unsupported; +0.17 s TTFA vs standard.

### 8.6 Implications for the Drive Mode voice decision (updates §6)

1. **The Gemini option strictly improves.** Same official rates as 3.1 Flash
   Live (so §5's ≈$22–32/month stands), but at that price you now get
   near-Minimal latency (1.18 s vs Minimal's 0.96 s), better-than-3.1-High
   reasoning (91.7% BBA vs a 71.5 index), conversational dynamics at 96.1%
   (3.1: 74.3%), #2 arena preference, and a stable model string.
   **Gemini 3.8 Live becomes the default candidate for any native S2S
   swap**, with 3.1 Flash Live as fallback.
2. **Standard over Extended Thinking for our two-lane design.** Our voice
   lane converses and relays; the worker lane owns every action. ET's
   headline skill (background agentic tool execution) duplicates the worker
   lane, and it costs ~93 Elo of conversational preference to get it. ET
   becomes relevant only if we ever want the *voice model itself* to run
   multi-step tasks — or for its progress-narration pattern, which is
   architecturally interesting for reading out worker-lane status.
3. **Migration has breaking changes to respect** (3.1 → 3.8 docs): omit
   `thinking_level` for standard 3.8 Live; remove `enable_affective_dialog`;
   proactive audio cannot be disabled; video frames are billed by default
   (set turn coverage explicitly); ET clients must treat `turnComplete` as
   non-terminal and follow `interaction_status`.
4. **Finnish still unverified.** 97 languages are claimed with
   mid-conversation switching, but our secondary-language bar (Finnish)
   remains untested on 3.8 Live; Gemini-family multilingual strength is
   presumed to carry over from 3.1 but is unproven.
5. **Competitive picture: the leader is now also the cheapest.** OpenAI's
   GPT-Live-1 (Astra) is beaten on the composite index for the first time;
   Grok keeps the TSR and raw-speed crowns; nobody is close on price. §6's
   conclusion — cost is not the deciding factor; latency, naturalness and
   deleting the STT→talker→TTS cascade are — is reinforced: the market's
   best-scoring voice model is now also its cheapest.

**Addendum sources (all fetched 2026-09-15):**

- AA tweet: <https://x.com/ArtificialAnlys/status/2099977679307243773> (via TwitterAPI.io, full text)
- AA live leaderboard/table: <https://artificialanalysis.ai/speech-to-speech>
- Google announcement: <https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-8-live-gemini-3-8-live-extended-thinking/>
- Google developers post (capabilities + per-min pricing): <https://blog.google/innovation-and-ai/technology/developers-tools/build-real-time-voice-applications-gemini-audio/>
- Official pricing, shared Live row: <https://ai.google.dev/gemini-api/docs/pricing> (§ gemini-3.8-live)
- Model docs: <https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live> · <https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live-extended-thinking>
- DeepMind model card: <https://deepmind.google/models/model-cards/gemini-3-8-audio/>
- SiliconANGLE (independent pricing/reasoning-token confirmation): <https://siliconangle.com/2026/09/15/googles-new-speech-model-gemini-3-8-live-supports-real-time-reasoning/>

---

## 9. Gap analysis (2026-09-16): what Voice Mode does, and what it is missing

> **Why this section is in the pricing file.** It was written as a companion to
> §8: the question *"is anything missing compared with what people generally
> look for in a voice agent?"* cannot be answered without the §8 Gemini 3.8 Live
> facts, and §9.4 below feeds directly back into §8.6's standing swap decision.
> A standalone gap-analysis document or a home in
> [`VOICE-MODE-INTENT.md`](./VOICE-MODE-INTENT.md)
> would be the more conventional placement; it lives here by operator request.
>
> **Method.** Compiled 2026-09-16 by reading the four voice documents
> (`VOICE-MODE.md`, `VOICE-MODE-INTENT-RESEARCH-2026-09.md`,
> `VOICE-ORCHESTRATOR-FEASIBILITY.md`, this file) against the shipped
> implementation. Every finding below is verified in code and cites the file it
> was verified in; the Gemini 3.8 Live facts in §9.4 are verified against
> Google's documentation and launch coverage (sources in §9.7). No code was
> changed.
>
> **Operator decision recorded 2026-09-16:** Finnish is a **nice-to-have, not a
> requirement**. Finding B below is retained because the code fact stands and it
> becomes load-bearing if a 97-language S2S front end is ever adopted (§9.4), but
> it is **not Tier 1 work** and is ranked accordingly in §9.5.

### 9.1 What Voice Mode is, and how you actually use it

**The mental model (two axes, not one).** The single most important thing in
`VOICE-ORCHESTRATOR-FEASIBILITY.md` §0 is the correction made on 2026-09-12:

- **Axis 1 — the relay:** is a talker carrying the operator's words, or is the
  operator typing?
- **Axis 2 — the worker's role:** is that session orchestrating children, or
  just coding?

They are independent. "Just talking to a coding session" is a first-class use
case, not a degraded one. This matters for the gap analysis because several
findings only show up in one quadrant (orchestrating by voice) and are invisible
in the other.

**The operating loop.**

```
you speak  →  STT  →  talker (Gemma 4 26B)  →  it talks back
                          ↓
                    holds your words as a DRAFT
                          ↓
you say "yes"  →  mechanical classifier  →  harness releases YOUR words
                                              →  worker (steer / prompt / follow-up)
```

The load-bearing idea: **the talker model has no send path**.
`server/src/talker/talker.ts` only calls the delivery adapter when (a) a draft
exists and (b) `utterance-classifier.ts` mechanically classifies the next
utterance as a confirmation. The model can *ask*; it can never *compose* what
goes out. That is N1 + N7, and it is genuinely well built.

**The controls that exist today.**

| Control | Where | What it does |
|---|---|---|
| Mic button | `DriveModeDictate.tsx` | Tap to start, tap to stop — push-to-talk |
| Confirmation card | `ConfirmationCard.tsx` | Shows what will be sent; can release the **original** wording (D2) |
| Reading level | `ReadingLevelControl.tsx` | Verbatim / Summary / Headlines, flips mid-answer |
| Focus / hold | `FocusControl.tsx` | Mutes worker answers; the operator hears only the talker |
| Stop talker | `DriveModeDictate.tsx` | Playback-only: silences the chunk, discards the queue |
| Stop worker | `DriveModeDictate.tsx:439` | Aborts the worker's run |
| Lane strip | `LaneStrip.tsx` | Up to 3 lanes in one tab, worker switchable in place |

**What has to be running.** Talker model via OpenRouter
(`google/gemma-4-26b-a4b-it`), OpenAI keys for STT (`gpt-4o-mini-transcribe`)
and TTS (`tts-1`), a worker session on Pi or Claude (Antigravity relays but
cannot be observed — see finding E), and optionally
`DICTATION_VOCABULARY_DB_PATH` for dictation biasing.

### 9.2 The intent, stated sharply

The four goal clauses are: talk fluently while tools run · very high intent
fidelity · never act on an unfinished thought · use quota already held.

Reading the whole corpus, **all four are met.** The two-week defect record
(P1–P27, the card wave, the relay-robustness wave) is a disciplined programme.
The honesty invariants in particular — "green never means delivered unless it
was delivered", "an untrue safety claim is worse than none" (P26) — are stronger
than what most commercial voice products ship.

So the interesting question is not "is the intent achieved". It is: **is the
intent complete?**

The answer is no, and the missing part has a shape. Everything below clusters
into a fifth clause that was never written down —

> **"…and it must work when my hands and eyes are busy."**

The system was built to be **safe** and **honest**. What people generally want
from voice agents, on top of that, is **ambient**: it notices things, it
interrupts *you* when it matters, and it works without looking at a screen. That
is the gap, and it is a coherent one rather than a scatter of missing features.

### 9.3 The findings

Eleven findings, each verified in code, ranked roughly by value-per-effort.

#### A. Turn-taking is a button, not a conversation — biggest

`useDictation.ts:218–261` — `MediaRecorder` starts on tap, stops on tap, then a
server round-trip for STT. There is no VAD, no endpointing, no wake word. A grep
of the whole client voice path returns zero hits for any of them.

The 2026 industry bar for voice agents is **semantic endpointing** (the agent
decides the operator is done from *content*, not a timer), **sub-800 ms**
last-user-audio → first-agent-audio, and **sub-150 ms barge-in**. A tap-stop
plus cascade round-trip structurally cannot get there.

And `DriveModeEntry.tsx:25` says, in the product: **"Voice-first, hands-free."**
Every single turn needs a tap. In a car, walking, or with a laptop closed, that
is the thing that breaks first.

Note the subtlety: the speech arbiter's barge-in is real but **playback-side
only** — it ducks audio when `dictation.state === 'recording'`. Since recording
only starts on a tap, "barge-in" today means "tap while it is talking". That is
not what the word means to anyone else in this market.

#### B. The mechanical gate is monolingual — retained, deprioritised

`TALKER-MODEL-REQUIREMENTS.md` states: *"Bilingual: fluent English primary,
Finnish secondary — the operator switches mid-conversation."* The operator
downgraded Finnish to a nice-to-have on 2026-09-16 (see the header note), so
this is **not Tier 1 work**. The code fact and its failure shape are recorded
because they become load-bearing under §9.4.

`utterance-classifier.ts:22–52`:

```
CANCEL_PATTERNS   = /no/, /never mind/, /forget it/, /scratch that/, /don't send/, …
CONFIRM_PATTERN   = /yes|yeah|yep|sure|ok|go ahead|send it|do it|confirmed/
PUSHBACK_PATTERN  = /just do it|stop asking|every single time/
QUESTION_LEADING  = /what|why|how|when|where|who|is|are|did|can|…/
```

All English. A grep for `kyllä|joo|lähetä|peruuta|fi-FI|locale|i18n` across
`server/src/talker/`, `client/src/components/DriveMode/`, `speechArbiter.ts`,
`tts.ts` and `dictation/` returns **zero hits**.

The consequences are asymmetric and both bad:

- **"joo, lähetä se"** → classifies as `statement` → does not release, *and
  accumulates into the draft*. The draft now holds the instruction plus the
  words "yes, send it" as content for the worker.
- **"ei, älä lähetä"** → the cancel does not fire → the draft stays live → a
  later English "yes" releases something the operator believed was killed.

That second case is the failure mode N3 exists to prevent, reached by a
different road. It is not a polish item; it is a hole in the one mechanism the
design rests on — it is simply a hole the operator does not currently walk into,
because they are speaking English.

#### C. Nothing about the surface can be said out loud

There is no spoken command for: *stop talking · louder · slower · say that again
· switch to headlines · switch to lane two · stop the worker.*

Worse — **"stop talking" classifies as `statement`**, so it is held as a pending
instruction for the worker. Said twice, "stop talking. stop talking." sits in
the draft.

Meanwhile every one of those is a button. And `abort` already exists in the
protocol (`shared/src/protocol-types.ts:35`) and is already wired
(`useWebSocket.ts:147`) — the talker path simply never calls it. For hands-free
operation, **"stop!" is the single most valuable utterance a human can make**,
and it is currently the one thing that requires reaching for a screen.

Fixing this is a small, bounded, mechanical allow-list — the same shape as the
existing classifier, so it fits the architecture rather than fighting it.

#### D. The worker's permission prompts never reach the voice lane — best value-per-effort

The trace:

```
worker asks for permission
  → connection.ts:1372  normalizedEvent.type === 'permission_request'
  → wrapped as extension_ui_request  (timeout: 120000)
  → sessionStore.ts:2407  set({ extensionUIRequest })
  → rendered by  components/Extensions/ExtensionDialog.tsx
```

A grep of `client/src/components/DriveMode/` and `server/src/talker/` for
`permission|approve|extension_ui_request` returns **zero hits in either**.

So: the operator is driving, Claude asks *"Allow Bash?"*, and the voice lane is
**completely silent**. The talker's state snapshot cannot see the pending
request, so asked "what is it doing?" it will honestly answer that it cannot
tell. Two minutes later the request times out and the turn is wasted.

This is the programme's own principle — *the operator must never have to
re-explain*, *nothing false is ever said or shown* — failing in a place nobody
looked. And the plumbing is entirely in place: the event exists, the response
path exists, the mechanical confirmation classifier exists. It is wiring, not
architecture.

#### E. The state view is much thinner than the intent promised

`types.ts` defines a rich `WorkerStateSnapshot`: `recentEvents`, `children`,
`pendingItems`, `activity`, `lastAssistantText`, `recentHistory`.
`state-view.ts` carefully bounds every one of them.

**No snapshot builder populates `recentEvents`, `children`, or `pendingItems`.**
The fields are dead.

What the talker actually receives:

| Runtime | Snapshot |
|---|---|
| Pi (`session-registry.ts:607`) | `worker status: running, step 4` + last assistant text + history |
| Claude (`:529`) | `worker status: running\|idle\|error` + last assistant text + history |
| Antigravity (`:503`) | `honestUnavailableActivity()` — **nothing** |
| OpenCode, Command Code | not in `TalkerRuntime` at all (`:55`) |

Compare feasibility §3.2 rule 1: *"answered conversationally from a compact
state view (task list, last N tool events, background-task statuses, last
assistant text)."* Three of those four never arrived.

So **"what is it doing right now?"** and **"how are the children doing?"** are
unanswerable — and those are precisely the questions asked while orchestrating,
which was the motivating scenario (the Antigravity run in the feasibility
document's §6 that started this programme). The runtime that motivated the
design is the one the talker is blind to.

P20/P23 made *history* excellent. *Live state* stayed at "status: running".

#### F. Nothing is proactive

`useAnswerReader.ts:492–495` — auto-speak fires on the
`isStreaming: true → false` transition. Turn end. That is the only trigger.

There is no *"the worker has been idle for ten minutes"*, no *"it has been
waiting on you for three minutes"*, no *"a child failed"*, no *"the build
broke"*.

`server/src/notifications/*` already sends Telegram on `agent_end`. Voice does
not use it. And this repo explicitly cares about long-horizon work
([`LONG-HORIZON-VALIDATION.md`](./LONG-HORIZON-VALIDATION.md), durable watches),
the whole point of which is that nobody is watching.

For a long-running agent the most-wanted voice behaviour is **"tell me when
something needs me"**, not "answer when I ask". The Headlines level —
*"Done: X. Needs you: Y."* — is exactly the right output shape, described in the
docs as *"designed to be left on permanently while wearing headphones."* But it
only fires at turn end. The format for ambient operation exists; the trigger
does not.

#### G. No mobile or car session hygiene

A grep for `mediaSession | wakeLock | setActionHandler` across the whole client
returns **zero**.

Meaning: the screen locks → audio and capture die. No lock-screen controls. No
headset-button or steering-wheel-button to start talking. No Bluetooth media
integration. No "now playing" metadata.

For a feature *named Drive Mode* and used from a phone, this is the layer
everyone expects and nobody writes down. The Media Session API is roughly a
day's work and would make the headset button a mic trigger — which is also a
partial answer to finding A.

#### H. Dictation accuracy is not context-aware

`dictation/vocabulary.ts` reads a single static `stt_vocabulary` row out of an
external SQLite database belonging to a different project (`config.ts:434` →
`/root/voicenotebot/streaming-dictation/backend/data/transcripts.db`).

Nothing feeds the **current session's actual nouns** into the STT prompt — repo
name, branch, recently-touched filenames, function names, model IDs, session
IDs, the words the worker used in its own last message.

Technical identifiers are exactly where dictation fails. Note what Google chose
to headline for 3.8 Live: **"alphanumeric precision — confirmation codes, claim
numbers and technical strings"** (§8.2). The market is naming this problem
because it is the top complaint. The biasing hook already exists here; it is
just pointed at a static list instead of live context. Cheapest quality win
available.

#### I. A draft can be extended but never corrected

`pending-proposal.ts:354` — *"Append an operator utterance to the draft.
Accumulates — never replaces."*

That is right for interleaved composition (P3). But it means a mid-thought
correction becomes *content*: *"rebase onto main… no wait, merge instead"* is
preserved in full, because `relay-normalise.ts` strips filler but never content.
A human reads through that fine. But it is the half-formed-thought problem
reappearing one layer down, inside an authorised send.

There is no *"replace that last bit"* affordance — the options are confirm,
cancel-and-re-say the whole thing, or send the original. Worth a design decision
rather than an accident.

#### J. Voice output is not tunable

`routes/tts.ts` — fixed voice allow-list, default `alloy`, **no speed control**.
For a Headlines mode explicitly designed to be *left on permanently*, playback
rate is the control people reach for first. Small, but it is free.

#### K. Observability measures the machine, not the conversation

The `voiceTurnId` vocabulary is genuinely excellent — phase, gate denial reason,
delivery outcome, released SHA. The audio regression lab measuring real OS-level
output is a level of rigour rarely seen.

But nothing measures the metrics this industry actually optimises:

- **end-to-end response latency** — last-user-audio → first-agent-audio.
  `modelTtftMs` is the *model leg only*; STT, TTS and network legs are in no
  budget.
- **barge-in success rate**
- **endpointing errors** (cut off early / waited too long)
- **STT word-error rate**, inferable for free from how often the operator
  cancels and re-says

This matters concretely for the standing S2S decision: swapping to Gemini 3.8
Live would leave **no before-number for the thing the swap is supposed to
improve**.

### 9.4 What Gemini 3.8 Live actually changes (extends §8.6)

§8's pricing analysis holds — same $3/$12 audio rates, ≈$22–32/month stands.
What follows is what §8 did not cover.

**What it genuinely fixes.**

| Finding | How |
|---|---|
| **A** (turn-taking) | Native VAD, endpointing and barge-in inside the Live session. 1.18 s TTFA, conversational dynamics 96.1% (vs 3.1's 74.3%). The *structural* fix, not a patch. |
| **H** (accuracy) | "Alphanumeric precision" is a named launch feature |
| **F** (proactive) | Async `NON_BLOCKING` function calling is now **the default** — the model can poll worker status in the background while continuing to speak |
| **J** | Native voice control |

**The architectural constraint not yet written down anywhere.**

N2 is: *the relay text is always the operator's own words, referenced by id from
the verbatim log.*

In a native speech-to-speech session, *there is no text of what the operator
said* — audio goes in, audio comes out. Therefore:

> **A native S2S swap must keep an input-transcription lane running purely to
> preserve the verbatim draft — even though transcription is the very cascade
> stage the swap was meant to delete.**

This does not kill the idea, but it changes the economics and the architecture
diagram. STT is not deleted; it is demoted from *the interaction path* to *the
evidence path*. That is still a large win (latency stops depending on it), but
§3's framing of "one S2S model replaces three of the four stages" is optimistic
by one stage. This should be written into §8.6 before anyone plans on it.

Findings **B** and **C** get *harder*, not easier: 97 languages with automatic
mid-conversation switching means a more fluent multilingual front end sitting on
a **monolingual gate**. That widens the distance between what the operator
believes was understood and what the mechanism actually did. If the swap
happens, B stops being a nice-to-have and becomes a precondition.

**Other migration facts worth pinning.**

- **`interaction_status` replaces `turnComplete` as the idle signal.** Clients
  must keep listening after `turnComplete: true` — background reasoning and tool
  calls may still follow. The entire phase machine
  (`DriveModeDictate.tsx`, `useAnswerReader.ts`) assumes turn end is terminal.
- **Session limits:** audio-only sessions cap at **~15 minutes** without context
  window compression (~25 audio tokens/sec); audio+video at **2 minutes**.
  Resumption tokens are valid 2 h; the server periodically resets the socket.
  The E1 mobile-durability work covers *this repo's* WebSocket — a Live session
  adds a **second socket with different failure semantics**, and the existing
  reconnect budget logic will not cover it.
- **Proactive audio is permanently enabled** (disabling returns an error). The
  model *will* speak unprompted. That collides head-on with the tier-4 rule
  ("chatter is dropped, not queued") and with "routine housekeeping is not
  news". The arbiter would be fighting the model's default behaviour.
- **Video frames are billed by default** — turn coverage defaults to
  `TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO`. Set it explicitly or pay for
  frames nobody wanted.
- **The ecosystem is still settling** — an open LiveKit issue
  (livekit/agents#7302) reports that with 3.8 Live's async-by-default, per-tool
  behaviour/scheduling cannot be set and tool results wait for playout. Relevant
  if this ever builds on a framework rather than the raw API.

**Standard vs Extended Thinking.** §8.6's conclusion — **standard, not ET** — is
right, and this analysis reinforces it: ET's headline skill is background
agentic tool execution, which *is the worker lane*. Paying ~93 Elo of
conversational preference to duplicate something already held is a bad trade.

But one idea is worth stealing from it. ET's **progress narration** — early
verbal acknowledgements ("Let me check that…") and live commentary while
background tasks run — is exactly the pattern that fixes finding F. That shape
can be implemented in the current Gemma talker today, without ET, by giving the
harness a periodic tick and a "needs you" trigger.

### 9.5 Recommended ordering

**Tier 1 — the intent's own promises, currently unkept. Small, bounded, uses
existing plumbing.**

1. **D — permission prompts into the voice lane.** Highest value-per-effort
   here. Route `permission_request` into the talker snapshot as `pendingItems`
   (the field already exists and is bounded), speak it at receipt-ack tier, and
   accept the answer through the *existing* mechanical confirm/cancel
   classifier. No new gate, no new authority.
2. **C — a spoken command allow-list.** `stop talking` · `stop the worker` ·
   `repeat that` · `louder/slower` · `headlines/summary/verbatim` · `lane two`.
   Mechanical, same shape as the classifier, denied-by-default. Wire
   `stop the worker` to the `abort` that already exists. This is the fix that
   makes "hands-free" true.

**Tier 2 — close the "what is it doing" hole.**

3. **E — populate the dead fields.** `recentEvents`, `children`, `pendingItems`
   for Pi and Claude; a real Antigravity snapshot; add OpenCode and Command Code
   to `TalkerRuntime`.
4. **F — proactive "needs you".** A harness tick plus the existing notification
   triggers, spoken in Headlines shape. This is what turns Voice Mode from a
   thing the operator operates into a thing that keeps them informed.
5. **H — context-aware dictation vocabulary.** Feed session nouns into the STT
   prompt alongside the static list.

**Tier 3 — change the interaction class.**

6. **K — conversation-latency telemetry first.** Do this *before* any S2S
   evaluation, so the swap is measurable. Without it the argument about the one
   thing the swap changes will be made from vibes.
7. **A — endpointing.** Either client-side VAD on the current cascade (cheap,
   partial) or the Gemini 3.8 Live swap (structural, and with the
   transcription-lane constraint in §9.4 understood).
8. **G — `mediaSession` + `wakeLock`.** About a day's work; makes the headset
   button a mic trigger and stops the screen lock killing the session.

**Nice-to-have, unranked.** **B** (bilingual gate — promoted to a precondition
only if a 97-language S2S front end is adopted), **I** (draft correction
affordance), **J** (TTS speed/voice control).

### 9.6 The one-sentence version

Voice Mode is an unusually principled **high-fidelity dictation gate with a
conversational front end** — and on fidelity, honesty and recovery it is better
than what is commercially shipping. What is missing is not a feature; it is a
posture. It currently **answers when addressed**; what people expect from a
voice agent in 2026 is one that **notices, interrupts, and works without a
screen** — and the cheapest steps toward that (permission prompts by voice, a
spoken stop, live worker state) are all wiring that already exists in this
codebase.

### 9.7 Sources for this section

**In-repo (verified by reading):** `server/src/talker/*` (`talker.ts`,
`utterance-classifier.ts`, `pending-proposal.ts`, `state-view.ts`, `types.ts`,
`session-registry.ts`, `delivery.ts`, `prompt.ts`),
`scripts/talker-prompts/v3-harness.txt`, `scripts/talker-prompts/digest.txt`,
`client/src/components/DriveMode/*`, `client/src/hooks/useDictation.ts`,
`client/src/hooks/useDriveModeDictation.ts`, `client/src/store/sessionStore.ts`,
`server/src/websocket/connection.ts`, `server/src/routes/tts.ts`,
`server/src/dictation/*`, `shared/src/protocol-types.ts`, `server/src/config.ts`.

**External (fetched 2026-09-16):**

- Google announcement: <https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-8-live-gemini-3-8-live-extended-thinking/>
- Gemini Live API session management (resumption tokens, context window compression, session limits): <https://ai.google.dev/gemini-api/docs/live-session>
- SiliconANGLE: <https://siliconangle.com/2026/09/15/googles-new-speech-model-gemini-3-8-live-supports-real-time-reasoning/>
- Unite.AI: <https://www.unite.ai/google-launches-gemini-3-8-live-and-extended-thinking-voice-models/>
- MarkTechPost: <https://www.marktechpost.com/2026/09/15/google-releases-gemini-3-8-live-and-3-8-live-extended-thinking-for-production-grade-voice-agents/>
- 9to5Google: <https://9to5google.com/2026/09/15/gemini-3-8-live-announced/>
- LiveKit agents issue 7302 (async-by-default caveats): <https://github.com/livekit/agents/issues/7302>
- Cekura, endpointing and turn detection: <https://www.cekura.ai/blogs/endpointing-in-voice-ai-turn-detection>
- SyncSoft, barge-in VAD tuning (sub-150 ms bar): <https://www.syncsoft.ai/en/blog/voice-agent-barge-in-vad-tuning-2026>
- Telnyx, voice agent latency benchmarks (sub-800 ms bar): <https://telnyx.com/resources/voice-ai-agents-compared-latency>
