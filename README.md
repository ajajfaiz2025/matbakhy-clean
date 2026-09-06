# matbakhy-clean

A [Next.js](https://nextjs.org) app. It currently contains two things:

1. **مطبخي (recipe bot)** — the original feature: a small UI (`app/page.js`) and
   API route (`app/api/recipe/route.js`) that suggests a recipe from a list of
   ingredients via OpenRouter.
2. **AI-Powered Content Repurposing Tool** — a new product being built out per
   [`docs/architecture.pdf`](./docs/architecture.pdf) (the technical
   architecture and development roadmap), which converts a long-form
   video/podcast into shorts, a transcript, blog posts, social captions, and
   publishing-ready metadata. This is the active area of development; see
   "Roadmap status" below.

## Getting started

```bash
cp .env.example .env   # fill in OPENROUTER_API_KEY, DATABASE_URL, REDIS_URL
npm install
npm run db:generate    # generate the Prisma client
npm run db:migrate     # create the database schema (needs a running Postgres)
npm run db:seed        # create a dev workspace + membership
npm run dev             # the Next.js app (control plane)
npm run worker          # the pipeline worker (media-processing plane), separately
```

Open [http://localhost:3000](http://localhost:3000) for the recipe bot UI. The worker
needs a running Redis (`REDIS_URL`) and requires `ffmpeg`/`ffprobe` on its `PATH`
for the normalization stage to succeed — without it, normalization jobs retry
with backoff and land in `dead_letter` (see "Known stubs" below).

## Roadmap status (content-repurposing tool)

Following the recommended first implementation sequence in
`docs/architecture.pdf` (section 16):

- [x] 1. Internal transcript, insight, artifact, and job schemas —
      `src/domain/schemas.ts` (Zod) and `prisma/schema.prisma`.
- [x] 2. Workspace authorization and usage-ledger primitives (partial) —
      `lib/workspace.ts` (dev header-based auth stub) and
      `lib/entitlements.ts` (plan limits + idempotent usage recording).
- [x] 3. Direct-to-object-storage uploads and immutable media records
      (partial) — `lib/storage.ts` + `POST /api/v1/uploads`,
      `PUT /api/v1/uploads/blob`, `POST /api/v1/uploads/{id}/complete`.
      Storage is a local-filesystem dev implementation; swap for an
      S3-compatible provider before production.
- [x] 4. Queue-backed normalization and transcription pipeline —
      `lib/queue.ts` (BullMQ/Redis, idempotent enqueue, retry + dead-letter),
      `lib/pipeline/normalizeMedia.ts` (checksum + ffprobe duration),
      `lib/pipeline/transcribeMedia.ts` + `lib/transcription/*` (provider
      abstraction: a working mock provider, plus an untested OpenAI Whisper
      provider), `workers/main.ts` (standalone worker process),
      `POST /api/v1/projects/{id}/transcription`, `GET /api/v1/jobs/{id}`.
      Verified end to end against a real local Postgres + Redis: upload →
      normalize (retries and dead-letters correctly without FFmpeg
      installed) → (simulated normalized media) → transcribe (mock
      provider) → transcript persisted → project marked `ready`.
- [ ] 5. Transcript viewer with timestamp navigation.
- [x] 6. Schema-validated insight extraction with provenance references —
      `src/domain/schemas.ts` (`editorialBriefSchema`), `lib/insights/*`
      (provider abstraction: a working mock provider covering Arabic and
      English, plus an untested OpenAI provider; `allam`/`humain` are
      recognized as valid future selections that fail loudly rather than
      silently falling back), `lib/insights/validate.ts` (schema +
      grounding validation, evidenceMap derived from real segments — never
      from the provider), `lib/pipeline/extractInsights.ts` (one bounded
      repair attempt on either validation failure, then fails rather than
      persisting anything ungrounded), `POST /api/v1/projects/{id}/analysis`,
      `GET /api/v1/projects/{id}/editorial-brief`. The compiled Editorial
      Brief is stored as a versioned `ContentArtifact`/`ArtifactVersion`
      (type `editorial_brief`) — old versions are never overwritten, and
      re-running with a changed audience produces a new version, while
      re-running unchanged reuses the same job. Atomic items are also
      mirrored into `Insight` rows for independent querying. 13 automated
      tests (`npm test`, Vitest) cover schema/grounding validation, mock
      extraction for English and Arabic fixtures, invalid-reference
      rejection, repair-path recovery, version creation, and queue-level
      idempotency — all passing against a real local Postgres + Redis. Full
      chain verified live: upload → normalize (simulated, no FFmpeg here) →
      transcribe (mock) → analyze (mock) → Editorial Brief retrieved via API
      with every evidence ID resolving to a real transcript segment.
- [ ] 7. Blog draft + caption set as versioned artifacts.
- [ ] 8. Deterministic short-video renderer with captions.
- [ ] 9. ZIP export, job progress, structured logs, failure recovery.
- [ ] 10. Billing limits + closed beta.

`POST /api/v1/projects` and `GET /api/v1/usage` are also implemented ahead of
schedule since they only depend on steps 1–3.

### Known stubs to replace before production

- **Auth** (`lib/workspace.ts`): resolves the workspace/user from
  `x-workspace-id` / `x-user-id` request headers. Replace with real session
  auth or a managed identity provider (architecture doc section 9).
- **Object storage** (`lib/storage.ts`): writes to `.data/storage` on local
  disk and proxies "signed URLs" through a Next.js route. Replace with an
  S3-compatible provider and real short-lived signed URLs.
- **FFmpeg**: `lib/pipeline/normalizeMedia.ts` shells out to `ffprobe` for
  duration extraction. If it's missing from `PATH`, the job retries with
  backoff and lands in `dead_letter` rather than falsely marking the media
  "normalized" — install FFmpeg on the worker host to fix this for real.
- **Transcription provider**: `lib/transcription/openaiProvider.ts` is
  implemented but has not been exercised against a real OpenAI API key in
  this environment. Without `OPENAI_API_KEY` set, the pipeline uses the
  deterministic mock provider (`lib/transcription/mockProvider.ts`), which
  does not perform real speech recognition.
- **Insight-extraction provider**: same situation as transcription —
  `lib/insights/openaiProvider.ts` is implemented but untested against a
  real key; the mock provider (`lib/insights/mockProvider.ts`) does not
  perform real language understanding. No HUMAIN/ALLAM integration exists;
  `INSIGHT_PROVIDER=allam` is recognized but throws explicitly rather than
  pretending to work.
- **Editorial Brief uniqueness**: "one editorial brief per project" is
  enforced by application logic (find-or-create inside a transaction) in
  `lib/pipeline/extractInsights.ts`, not by a database constraint — two
  concurrent first-time analysis runs for the same project could in theory
  race and create two `ContentArtifact` rows. Low risk in practice since
  jobs are also deduplicated by idempotency key.
- **Billing**: `PLAN_LIMITS` in `lib/entitlements.ts` is a hardcoded
  placeholder until step 10 wires up a real subscription-billing provider.

### Trying the upload → project flow locally

```bash
# 1. Create an upload session (dev-user is seeded as owner of dev-workspace)
curl -X POST localhost:3000/api/v1/uploads \
  -H 'content-type: application/json' \
  -H 'x-workspace-id: dev-workspace' -H 'x-user-id: dev-user' \
  -d '{"fileName":"episode.mp4","mimeType":"video/mp4"}'
# -> { "mediaFileId": "...", "uploadUrl": "/api/v1/uploads/blob?key=...", ... }

# 2. PUT the file to the returned uploadUrl
curl -X PUT "localhost:3000$UPLOAD_URL" --data-binary @episode.mp4

# 3. Mark the upload complete
curl -X POST "localhost:3000/api/v1/uploads/$MEDIA_FILE_ID/complete" \
  -H 'x-workspace-id: dev-workspace' -H 'x-user-id: dev-user'

# 4. Create a project from it (requires the source media to have
#    reached "normalized" — check via GET /api/v1/jobs/{jobId})
curl -X POST localhost:3000/api/v1/projects \
  -H 'content-type: application/json' \
  -H 'x-workspace-id: dev-workspace' -H 'x-user-id: dev-user' \
  -d '{"title":"My Episode","sourceMediaId":"'"$MEDIA_FILE_ID"'"}'

# 5. Start transcription
curl -X POST "localhost:3000/api/v1/projects/$PROJECT_ID/transcription" \
  -H 'x-workspace-id: dev-workspace' -H 'x-user-id: dev-user'

# 6. Poll job status
curl "localhost:3000/api/v1/jobs/$JOB_ID" \
  -H 'x-workspace-id: dev-workspace' -H 'x-user-id: dev-user'

# 7. Start insight extraction (requires a transcript; audience is optional
#    and, if changed, produces a new Editorial Brief version)
curl -X POST "localhost:3000/api/v1/projects/$PROJECT_ID/analysis" \
  -H 'content-type: application/json' \
  -H 'x-workspace-id: dev-workspace' -H 'x-user-id: dev-user' \
  -d '{"audience":"early-stage founders"}'

# 8. Retrieve the Editorial Brief
curl "localhost:3000/api/v1/projects/$PROJECT_ID/editorial-brief" \
  -H 'x-workspace-id: dev-workspace' -H 'x-user-id: dev-user'
```

## Testing

```bash
npm test   # Vitest — schema/grounding validation, mock-provider EN/AR
           # fixtures, and pipeline integration tests against the real
           # DATABASE_URL/REDIS_URL from .env (no mocking of Postgres/Redis)
```

## Learn more (Next.js)

- [Next.js Documentation](https://nextjs.org/docs)
- [Learn Next.js](https://nextjs.org/learn)
- [Deploying on Vercel](https://nextjs.org/docs/app/building-your-application/deploying)
