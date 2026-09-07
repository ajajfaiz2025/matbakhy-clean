# Real LLM Integration & Validation — Readiness

This document is the prep work for the one remaining blocker before a beta
decision: **every insight and every generated draft so far has come from the
mock provider.** Two prior validation rounds (Product Validation Report,
Real LLM Validation Phase) confirmed the rendering/entitlement/grounding
infrastructure is sound, but explicitly could not validate real-model output
quality — no API key exists in the environment those reports were written in.

This doc verifies the project is actually ready to run that validation the
moment a key is available, without redesigning anything. **No architecture
changed. The mock provider was not touched or removed.**

## ⚠️ A key alone is not sufficient in a Claude Code Remote environment

Testing this directly (see "What was verified" below) surfaced a second,
independent blocker: **this environment's network egress policy blocks
`api.openai.com`.** A request to it fails with `403 Host not in allowlist`
from the session's own network proxy — before OpenAI ever sees the request,
regardless of whether the key is valid.

```
$ curl https://api.openai.com/v1/models
curl: (56) CONNECT tunnel failed, response 403
```

This is an environment-level network policy, not application code — it
cannot be fixed from inside this repo. Before running the real validation,
either:

- **Reconfigure the environment's network policy** to allow egress to
  `api.openai.com` (see the network-policy options at
  [code.claude.com/docs/en/claude-code-on-the-web](https://code.claude.com/docs/en/claude-code-on-the-web)), or
- **Run `npm run validate:real` from an environment/session that already
  has that access** (e.g. a local machine, or a differently-configured
  remote environment) — the script and everything else in this doc still
  applies unchanged there.

## 1–2. Environment variables — what's required, and where each is read

| Variable | Required? | Read in | Purpose |
|---|---|---|---|
| `OPENAI_API_KEY` | **Yes**, for any real call | `lib/transcription/openaiProvider.ts:14`, `lib/insights/openaiProvider.ts:117,127,142`, `lib/generation/openaiProvider.ts:126,136`, plus the routers below | Bearer token for every OpenAI HTTP call. Read fresh at call time — never cached, never a literal. |
| `INSIGHT_PROVIDER` | No | `lib/insights/index.ts:18` | `"mock"` \| `"openai"` to force a choice; unset auto-detects from `OPENAI_API_KEY`. |
| `GENERATION_PROVIDER` | No | `lib/generation/index.ts:27` | Same, for content generation. |
| *(none)* for transcription | — | `lib/transcription/index.ts:6` | No override variable exists — routing is key-presence only. Documented asymmetry, not a bug; see §5. |
| `TRANSCRIPTION_TIMEOUT_MS` | No | `lib/transcription/openaiProvider.ts:30` (via `getProviderTimeoutMs`) | Per-call timeout override, default 120,000ms. |
| `INSIGHT_TIMEOUT_MS` | No | `lib/insights/openaiProvider.ts:90` | Default 60,000ms (`PROVIDER_TIMEOUT_MS` fallback, else 60,000ms — see `lib/providers/fetchWithTimeout.ts`). |
| `GENERATION_TIMEOUT_MS` | No | `lib/generation/openaiProvider.ts:91` | Same pattern. |
| `PROVIDER_TIMEOUT_MS` | No | `lib/providers/fetchWithTimeout.ts:14` | Global fallback used when a stage-specific `*_TIMEOUT_MS` isn't set. |
| `FFMPEG_TIMEOUT_MS` | No | `lib/rendering/config.ts:35` | Unrelated to LLM calls — FFmpeg subprocess timeout, default 180,000ms. Already verified in Step 8. |
| `INSIGHT_CHUNK_TOKEN_BUDGET` | No | `lib/insights/chunk.ts:6` | Long-transcript chunking threshold, default 6,000 (est. tokens). Unaffected by which provider is active. |
| `DATABASE_URL`, `REDIS_URL` | Yes (already set) | `lib/db.ts:15`, `lib/queue.ts:12` | Unrelated to the LLM provider; already configured in `.env`. |

The model itself (`gpt-4o-mini` for insights/generation, `whisper-1` for
transcription) is a literal in the provider files, not an env var. Not
changed here — out of scope for this readiness pass, and changing it isn't
needed to run the validation.

## 3. Real provider wiring — confirmed

`tests/providers/router.test.ts` (14 tests, new this phase, all passing —
no network access needed, these only check which provider *object* a
router hands back) proves:

- `getContentProviders()`, `getInsightProvider()`, `getTranscriptionProvider()`
  all resolve to the real OpenAI provider when `OPENAI_API_KEY` is set (or
  when explicitly requested via `*_PROVIDER=openai`, even without a key —
  it fails at call time instead, with a clear `OPENAI_API_KEY is not
  configured.` error, not at routing time).
- `extractInsights` → `getInsightProvider()` → `openaiInsightProvider`
  (`lib/pipeline/extractInsights.ts:97`).
- `generateContent`'s caller (`lib/generation/enqueue.ts`) →
  `getContentProviders()` → `openaiContentProvider` as primary.
- `transcribeMedia` → `getTranscriptionProvider()` →
  `openaiTranscriptionProvider` (`lib/pipeline/transcribeMedia.ts:24`).

## 4. Mock provider — confirmed still available

Also proven by `tests/providers/router.test.ts`: an explicit
`GENERATION_PROVIDER=mock` / `INSIGHT_PROVIDER=mock` returns the mock
provider **even when a real key is configured** — a real key does not
force real calls project-wide. The full 124-test automated suite still
runs entirely against the mock providers (via direct injection, bypassing
the router), unaffected by whether a key exists.

## 5. Provider routing/fallback behavior — confirmed, and one asymmetry to know before scoring

| Stage | Explicit override? | Fallback on outright failure? |
|---|---|---|
| Transcription | No | No — throws, BullMQ retries (5x, exponential backoff) |
| Insight extraction | Yes (`INSIGHT_PROVIDER`) | **No** — throws, BullMQ retries the same way |
| Content generation | Yes (`GENERATION_PROVIDER`) | **Yes** — silently falls back to the mock provider (`lib/generation/index.ts:35,42`) |

**This matters for scoring the real run**: if the real OpenAI generation
call fails outright (network blip, rate limit, auth issue), the pipeline
will silently produce mock output and mark the job "succeeded" — same
behavior a real user would see, by design (a safety net, not a bug), but it
means a "succeeded" job is not proof of real output. `scripts/realLlmValidation.ts`
checks `ArtifactVersion.model` on every generated artifact and flags
anything that isn't `openai:*` — always check those flags before scoring
an artifact as a real result.

## 6. Timeouts and retries — confirmed wired correctly

- Every OpenAI HTTP call goes through `fetchWithTimeout` (AbortController-based,
  same mechanism verified in the P1 quality-gate phase) — a hang is killed
  and converted to a normal thrown error, never left open indefinitely.
- That thrown error (timeout or otherwise) feeds into the **same** BullMQ
  retry/backoff every other pipeline stage uses: 5 attempts, exponential
  backoff starting at 2,000ms (`lib/queue.ts:36-47`) — no separate retry
  path was added for real providers.
- Insight extraction additionally has its own bounded `repair()` retry (one
  extra call on a validation/grounding failure) and `reconcile()` for
  chunked long transcripts — both implemented in
  `lib/insights/openaiProvider.ts`, unverified against a live key but
  structurally identical to the already-tested mock path.

## 7. No hard-coded secrets — confirmed

- `grep`'d the whole repo for `sk-[a-zA-Z0-9]` literals and for
  `apiKey: "..."`-shaped assignments outside `process.env` reads — none
  found.
- Every real provider reads `process.env.OPENAI_API_KEY` fresh at call
  time; the provider *objects* themselves carry no key field
  (`tests/providers/router.test.ts`'s last test asserts this structurally).

## 8. Running the real validation

```bash
OPENAI_API_KEY=sk-... npm run validate:real
```

(equivalent to `OPENAI_API_KEY=sk-... npx tsx scripts/realLlmValidation.ts`)

This requires Postgres and Redis running locally (same as the test suite)
and network egress to `api.openai.com` (see the warning at the top of this
doc). It:

1. Fails immediately, before any DB/network work, if `OPENAI_API_KEY` is unset.
2. Prints which provider each stage resolved to.
3. Seeds the **same 4 inputs** used in both prior validation reports (Gulf
   conversational, MSA educational, English podcast, Gulf code-switched) —
   identical transcript text, so results are directly comparable.
4. Runs real `extractInsights` → real `generateContent` (all 4 platforms)
   → real FFmpeg `renderShortVideo` for every candidate clip the real
   provider returns.
5. Flags any artifact whose `model` isn't `openai:*` (silent mock fallback)
   or that contains a leftover mock marker (`[mock`, `[تجريبي]`, etc.) —
   these should never appear in real output; their presence is a bug to
   investigate, not a scoring nuance.
6. Writes full JSON (`editorial_brief.json`, `generated_content.json`,
   `render_results.json` per input) to
   `.data/real-validation-results/<timestamp>/` for manual scoring against
   the REAL LLM SCORECARD rubric, and leaves the workspaces in the database
   for inspection (clean up manually afterward — the script does not delete
   them, since you'll likely want to look at the UI first).

### Note on transcription specifically

There is still no real speech audio anywhere in this environment (only a
synthetic FFmpeg test-pattern video, same as Step 8 and both prior
validation rounds) — a real Whisper call against it would transcribe
silence/tone, not produce a meaningful transcript. `scripts/realLlmValidation.ts`
therefore seeds the same hand-authored transcripts as before and validates
**insight extraction and generation** against a real model, not
transcription's output quality. If real audio/video becomes available,
point the script at it instead (swap the `generateSyntheticVideo` +
hand-authored-transcript block for a real upload, then let
`getTranscriptionProvider()` run for real).

### Cost (assumption, not fetched live this session)

~4 insight-extraction calls + up to a few repair/reconcile retries, + 16
generation calls (4 platforms × 4 inputs), each against short (<1,000
input token) prompts. At published `gpt-4o-mini` rates this is on the
order of $0.01–0.05 total for one full run — verify current pricing before
relying on this figure.

## What to do with the results

Score each of the 4 inputs' real output against the same rubric used in
the prior mock-only report:

**REAL LLM SCORECARD** (1–5 each): Source fidelity, Grounding, Usefulness,
Platform fit, Arabic naturalness, English naturalness, Hook quality,
Repetition, Candidate clip quality, Short-video usefulness.

Compare directly against the last MOCK scorecard (Real LLM Validation
Phase report):

| Area | Mock |
|---|---|
| Source fidelity | 5/5 |
| Grounding | 5/5 |
| Hook quality | 1/5 |
| Platform fit | 3/5 |
| Arabic quality | 3/5 |
| English quality | 3/5 |
| Repetition | 1/5 |
| Candidate clip quality | 3.3/5 |
| Short-video usefulness | 2.8/5 |

Then choose exactly one: 🟢 BETA READY / 🟡 FIX BEFORE BETA / 🔴 FUNDAMENTAL
PRODUCT PROBLEM — never 🟢 based on mock results, per the standing
instruction across all three validation rounds so far.
