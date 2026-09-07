'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import type {
  BlogDraftData,
  EditorialBrief,
  GenerationArtifactType,
  GroundingRef,
  ShortVideoArtifactBody,
  SocialDraftData,
  SocialPlatform,
  SupportedLanguage,
} from '../../../../src/domain/schemas';

type ArtifactKind = GenerationArtifactType | 'short_video';

interface ArtifactSummary {
  id: string;
  type: ArtifactKind;
  platform: SocialPlatform | null;
  language: SupportedLanguage;
  status: string;
  currentVersionId: string | null;
  title: string | null;
  updatedAt: string | null;
}

type ArtifactBody =
  | { kind: 'blog_draft'; data: BlogDraftData; groundingMap: Record<string, GroundingRef> }
  | { kind: 'social_post' | 'caption'; data: SocialDraftData; groundingMap: Record<string, GroundingRef> }
  | ShortVideoArtifactBody;

interface ArtifactDetail {
  id: string;
  type: ArtifactKind;
  platform: SocialPlatform | null;
  language: SupportedLanguage;
  status: string;
  currentVersionId: string;
  body: ArtifactBody;
  downloadUrl: string | null;
  model: string | null;
  versions: Array<{ id: string; createdAt: string; createdBy: string }>;
}

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

const GENERATION_TARGETS: Array<{
  label: string;
  artifactType: GenerationArtifactType;
  platform: SocialPlatform | null;
}> = [
  { label: 'Generate Blog', artifactType: 'blog_draft', platform: null },
  { label: 'Generate X Post', artifactType: 'social_post', platform: 'x' },
  { label: 'Generate LinkedIn Post', artifactType: 'social_post', platform: 'linkedin' },
  { label: 'Generate Instagram Caption', artifactType: 'caption', platform: 'instagram' },
];

function isBlog(body: ArtifactDetail['body']): body is { kind: 'blog_draft'; data: BlogDraftData; groundingMap: Record<string, GroundingRef> } {
  return body.kind === 'blog_draft';
}

function isSocial(body: ArtifactDetail['body']): body is { kind: 'social_post' | 'caption'; data: SocialDraftData; groundingMap: Record<string, GroundingRef> } {
  return body.kind === 'social_post' || body.kind === 'caption';
}

function isShortVideo(body: ArtifactDetail['body']): body is ShortVideoArtifactBody {
  return body.kind === 'short_video';
}

export default function ContentResultsPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;

  const [workspaceId, setWorkspaceId] = useState('dev-workspace');
  const [userId, setUserId] = useState('dev-user');
  const [language, setLanguage] = useState<SupportedLanguage>('en');
  const [artifacts, setArtifacts] = useState<ArtifactSummary[]>([]);
  const [details, setDetails] = useState<Record<string, ArtifactDetail>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<BlogDraftData | SocialDraftData | null>(null);
  const [brief, setBrief] = useState<EditorialBrief | null>(null);

  const authHeaders = useCallback(
    () => ({ 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-user-id': userId }),
    [workspaceId, userId]
  );

  const loadArtifacts = useCallback(async () => {
    const res = await fetch(`/api/v1/projects/${projectId}/artifacts`, { headers: authHeaders() });
    if (!res.ok) {
      setStatusMessage(`Failed to load artifacts (${res.status})`);
      return;
    }
    const data = (await res.json()) as { artifacts: ArtifactSummary[] };
    setArtifacts(data.artifacts);
    setStatusMessage('');
  }, [projectId, authHeaders]);

  const loadBrief = useCallback(async () => {
    const res = await fetch(`/api/v1/projects/${projectId}/editorial-brief`, { headers: authHeaders() });
    if (!res.ok) return; // No brief yet — the Short Videos section just stays empty.
    const data = (await res.json()) as { brief: EditorialBrief };
    setBrief(data.brief);
  }, [projectId, authHeaders]);

  useEffect(() => {
    if (projectId) {
      loadArtifacts();
      loadBrief();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function loadDetail(artifactId: string) {
    const res = await fetch(`/api/v1/artifacts/${artifactId}`, { headers: authHeaders() });
    if (!res.ok) {
      setStatusMessage(`Failed to load artifact (${res.status})`);
      return null;
    }
    const detail = (await res.json()) as ArtifactDetail;
    setDetails((prev) => ({ ...prev, [artifactId]: detail }));
    return detail;
  }

  async function pollJob(jobId: string): Promise<'succeeded' | 'failed' | 'dead_letter' | 'timeout'> {
    // 90 attempts at 1s: generous enough for a real FFmpeg render, not
    // just the near-instant mock text providers.
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const res = await fetch(`/api/v1/jobs/${jobId}`, { headers: authHeaders() });
      if (res.ok) {
        const { job } = (await res.json()) as { job: { status: string; error: string | null } };
        if (job.status === 'succeeded') return 'succeeded';
        if (job.status === 'failed' || job.status === 'dead_letter') {
          setStatusMessage(job.error ?? 'Generation failed.');
          return job.status;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return 'timeout';
  }

  async function generate(artifactType: GenerationArtifactType, platform: SocialPlatform | null) {
    const key = `${artifactType}:${platform ?? 'none'}`;
    setBusyKey(key);
    setStatusMessage('Generating…');
    try {
      const res = await fetch(`/api/v1/projects/${projectId}/content`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ artifactType, platform: platform ?? undefined, language, tone: 'informative', audience: '' }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setStatusMessage(body.error ?? `Request failed (${res.status})`);
        return;
      }
      const { jobId } = (await res.json()) as { jobId: string };
      const outcome = await pollJob(jobId);
      setStatusMessage(outcome === 'succeeded' ? 'Done.' : `Generation ${outcome}.`);
      await loadArtifacts();
    } finally {
      setBusyKey(null);
    }
  }

  async function createShort(candidateClipId: string) {
    const key = `render:${candidateClipId}`;
    setBusyKey(key);
    setStatusMessage('Rendering short video…');
    try {
      const res = await fetch(`/api/v1/projects/${projectId}/render`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ candidateClipId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setStatusMessage(body.error ?? `Request failed (${res.status})`);
        return;
      }
      const { jobId } = (await res.json()) as { jobId: string };
      const outcome = await pollJob(jobId);
      setStatusMessage(outcome === 'succeeded' ? 'Short video ready.' : `Render ${outcome}.`);
      await loadArtifacts();
    } finally {
      setBusyKey(null);
    }
  }

  async function regenerate(artifactId: string) {
    setBusyKey(artifactId);
    setStatusMessage('Regenerating…');
    try {
      const res = await fetch(`/api/v1/artifacts/${artifactId}/regenerate`, { method: 'POST', headers: authHeaders() });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setStatusMessage(body.error ?? `Request failed (${res.status})`);
        return;
      }
      const { jobId } = (await res.json()) as { jobId: string };
      const outcome = await pollJob(jobId);
      setStatusMessage(outcome === 'succeeded' ? 'Regenerated.' : `Regeneration ${outcome}.`);
      await Promise.all([loadArtifacts(), loadDetail(artifactId)]);
    } finally {
      setBusyKey(null);
    }
  }

  function startEdit(detail: ArtifactDetail) {
    if (isShortVideo(detail.body)) return; // no editor for short videos (Step 8 scope)
    setEditingId(detail.id);
    setEditDraft(structuredClone(detail.body.data));
  }

  async function saveEdit(artifactId: string) {
    if (!editDraft) return;
    setBusyKey(`edit:${artifactId}`);
    try {
      const res = await fetch(`/api/v1/artifacts/${artifactId}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ data: editDraft }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setStatusMessage(body.error ?? `Save failed (${res.status})`);
        return;
      }
      setStatusMessage('Saved.');
      setEditingId(null);
      setEditDraft(null);
      await Promise.all([loadArtifacts(), loadDetail(artifactId)]);
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif', maxWidth: 900, margin: '0 auto' }}>
      <h1>Content Results</h1>
      <p style={{ color: '#555' }}>Project: {projectId}</p>

      <section style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <label>
          Workspace{' '}
          <input value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} style={{ width: 140 }} />
        </label>
        <label>
          User <input value={userId} onChange={(e) => setUserId(e.target.value)} style={{ width: 120 }} />
        </label>
        <label>
          Language{' '}
          <select value={language} onChange={(e) => setLanguage(e.target.value as SupportedLanguage)}>
            <option value="en">English</option>
            <option value="ar">Arabic</option>
          </select>
        </label>
        <button
          onClick={() => {
            loadArtifacts();
            loadBrief();
          }}
        >
          Refresh
        </button>
      </section>

      <section style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {GENERATION_TARGETS.map((target) => {
          const key = `${target.artifactType}:${target.platform ?? 'none'}`;
          return (
            <button key={key} disabled={busyKey === key} onClick={() => generate(target.artifactType, target.platform)}>
              {busyKey === key ? 'Working…' : target.label}
            </button>
          );
        })}
      </section>

      <section style={{ marginBottom: 24, border: '1px solid #ddd', borderRadius: 8, padding: 16 }}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>Short Videos</h2>
        {!brief && <p style={{ color: '#888' }}>No Editorial Brief yet — generate one before creating short videos.</p>}
        {brief && brief.candidateClips.length === 0 && (
          <p style={{ color: '#888' }}>The current Editorial Brief has no candidate clips.</p>
        )}
        {brief && brief.candidateClips.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {brief.candidateClips.map((clip) => {
              const key = `render:${clip.id}`;
              return (
                <div
                  key={clip.id}
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, borderBottom: '1px solid #eee', paddingBottom: 8 }}
                >
                  <div>
                    <div style={{ fontSize: 13 }}>
                      {formatTimestamp(clip.startMs)} – {formatTimestamp(clip.endMs)}
                    </div>
                    <div style={{ fontSize: 13, color: '#555' }}>{clip.rationale}</div>
                  </div>
                  {/* Idempotent: re-clicking after a render already exists is a no-op that returns the same job/artifact. */}
                  <button disabled={busyKey === key} onClick={() => createShort(clip.id)}>
                    {busyKey === key ? 'Rendering…' : 'Create Short'}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {statusMessage && <p style={{ color: '#333' }}>{statusMessage}</p>}

      {artifacts.length === 0 && <p>No content generated yet — pick a button above.</p>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {artifacts.map((artifact) => {
          const detail = details[artifact.id];
          const isEditing = editingId === artifact.id;
          const sourceCount = detail
            ? isShortVideo(detail.body)
              ? detail.body.evidence.length
              : Object.keys(detail.body.groundingMap).length
            : null;

          return (
            <div key={artifact.id} style={{ border: '1px solid #ddd', borderRadius: 8, padding: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                <div>
                  <strong>{artifact.title ?? '(untitled)'}</strong>
                  <div style={{ fontSize: 12, color: '#666' }}>
                    {artifact.type}
                    {artifact.platform ? ` · ${artifact.platform}` : ''} · {artifact.language} · {artifact.status}
                    {sourceCount !== null && ` · ✓ grounded in ${sourceCount} source${sourceCount === 1 ? '' : 's'}`}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => loadDetail(artifact.id)}>{detail ? 'Reload' : 'View'}</button>
                  {artifact.type !== 'short_video' && (
                    <button disabled={busyKey === artifact.id} onClick={() => regenerate(artifact.id)}>
                      {busyKey === artifact.id ? 'Working…' : 'Regenerate'}
                    </button>
                  )}
                </div>
              </div>

              {detail && !isEditing && isShortVideo(detail.body) && (
                <div style={{ marginTop: 12 }}>
                  <p style={{ fontSize: 13, color: '#555' }}>Source candidate clip: {detail.body.candidateClipId}</p>
                  {detail.downloadUrl ? (
                    // eslint-disable-next-line jsx-a11y/media-has-caption
                    <video controls style={{ maxWidth: 280, aspectRatio: '9 / 16', background: '#000' }} src={detail.downloadUrl} />
                  ) : (
                    <p style={{ color: '#a15c00' }}>No download URL available.</p>
                  )}
                  <div style={{ fontSize: 13, marginTop: 8 }}>
                    <div>Clip rationale: {detail.body.clipRationale}</div>
                    <div>
                      Output: {detail.body.output.width}×{detail.body.output.height} · {(detail.body.output.durationMs / 1000).toFixed(1)}s ·{' '}
                      {detail.body.output.videoCodec}
                      {detail.body.output.hasAudio ? `/${detail.body.output.audioCodec}` : ' (no audio)'} ·{' '}
                      {(detail.body.output.fileSizeBytes / (1024 * 1024)).toFixed(2)} MB
                    </div>
                    <div>
                      Processing: {(detail.body.performance.renderDurationMs / 1000).toFixed(1)}s for{' '}
                      {(detail.body.performance.sourceDurationMs / 1000).toFixed(1)}s of video (ratio{' '}
                      {detail.body.performance.processingRatio.toFixed(2)}×)
                    </div>
                    {detail.body.sourceUpscaled && <div style={{ color: '#a15c00' }}>⚠ Source resolution was smaller than 1080×1920 and was upscaled.</div>}
                    {detail.downloadUrl && (
                      <a href={detail.downloadUrl} download style={{ display: 'inline-block', marginTop: 4 }}>
                        Download MP4
                      </a>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: '#888', marginTop: 8 }}>
                    model: {detail.model ?? 'unknown'} · version {detail.versions.length} of {detail.versions.length}
                  </div>
                </div>
              )}

              {detail && !isEditing && !isShortVideo(detail.body) && (isBlog(detail.body) || isSocial(detail.body)) && (
                <div style={{ marginTop: 12 }}>
                  {isBlog(detail.body) ? (
                    <div>
                      <p>
                        <em>{detail.body.data.introduction}</em>
                      </p>
                      {detail.body.data.sections.map((section, i) => (
                        <div key={i} style={{ marginBottom: 8 }}>
                          <h4 style={{ margin: '4px 0' }}>{section.heading}</h4>
                          <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{section.body}</p>
                        </div>
                      ))}
                      <p>{detail.body.data.conclusion}</p>
                      {detail.body.data.callToAction && <p><strong>CTA:</strong> {detail.body.data.callToAction.text}</p>}
                      {detail.body.data.unsupportedClaims.length > 0 && (
                        <p style={{ color: '#a15c00', fontSize: 13 }}>
                          ⚠ {detail.body.data.unsupportedClaims.length} claim(s) flagged as unverified
                        </p>
                      )}
                    </div>
                  ) : (
                    <div>
                      <p style={{ whiteSpace: 'pre-wrap' }}>
                        <strong>{detail.body.data.hook}</strong>
                        {'\n'}
                        {detail.body.data.body}
                      </p>
                      {detail.body.data.callToAction && <p><strong>CTA:</strong> {detail.body.data.callToAction}</p>}
                      {detail.body.data.hashtags.length > 0 && <p>{detail.body.data.hashtags.join(' ')}</p>}
                    </div>
                  )}
                  <div style={{ fontSize: 12, color: '#888' }}>
                    model: {detail.model ?? 'human edit'} · version {detail.versions.length} of {detail.versions.length}
                  </div>
                  <button onClick={() => startEdit(detail)} style={{ marginTop: 8 }}>
                    Edit
                  </button>
                </div>
              )}

              {isEditing && editDraft && (
                <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {'introduction' in editDraft ? (
                    <>
                      <textarea
                        value={editDraft.introduction}
                        onChange={(e) => setEditDraft({ ...editDraft, introduction: e.target.value })}
                        rows={2}
                      />
                      {editDraft.sections.map((section, i) => (
                        <textarea
                          key={i}
                          value={section.body}
                          onChange={(e) => {
                            const sections = [...editDraft.sections];
                            sections[i] = { ...sections[i], body: e.target.value };
                            setEditDraft({ ...editDraft, sections });
                          }}
                          rows={3}
                        />
                      ))}
                      <textarea
                        value={editDraft.conclusion}
                        onChange={(e) => setEditDraft({ ...editDraft, conclusion: e.target.value })}
                        rows={2}
                      />
                    </>
                  ) : (
                    <>
                      <input value={editDraft.hook} onChange={(e) => setEditDraft({ ...editDraft, hook: e.target.value })} />
                      <textarea
                        value={editDraft.body}
                        onChange={(e) => setEditDraft({ ...editDraft, body: e.target.value })}
                        rows={4}
                      />
                    </>
                  )}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button disabled={busyKey === `edit:${artifact.id}`} onClick={() => saveEdit(artifact.id)}>
                      Save
                    </button>
                    <button
                      onClick={() => {
                        setEditingId(null);
                        setEditDraft(null);
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </main>
  );
}
