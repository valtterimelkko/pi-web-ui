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
>
> **Addendum 2026-09-15:** Google launched **Gemini 3.8 Live** and **Gemini
> 3.8 Live Extended Thinking** the day after this research was written. §8
> records the announcement, Google's product facts, Artificial Analysis's
> first measurements, and the official pricing (confirmed identical to
> 3.1 Flash Live). §§1–7 stand except where §8 notes otherwise.

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
