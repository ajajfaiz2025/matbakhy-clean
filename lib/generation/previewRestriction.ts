import type { BlogDraftData, GroundingRef, SocialDraftData } from '../../src/domain/schemas';

const BLOG_PREVIEW_SECTION_COUNT = 1;
const SOCIAL_PREVIEW_BODY_CHARS = 160;
const SOCIAL_PREVIEW_HASHTAG_COUNT = 1;
const SOCIAL_PREVIEW_EVIDENCE_COUNT = 1;

function pickGroundingSubset(
  groundingMap: Record<string, GroundingRef>,
  keepIds: readonly string[]
): Record<string, GroundingRef> {
  const kept: Record<string, GroundingRef> = {};
  for (const id of keepIds) {
    if (groundingMap[id]) kept[id] = groundingMap[id];
  }
  return kept;
}

/**
 * Free-trial preview restriction (P1 fix, quality-gate section B): the
 * free plan's generated content must "demonstrate real product value"
 * without "simply expos[ing] the entire paid output." Applied only to
 * a draft that has already passed full grounding validation, so a
 * preview is always a genuine, still-grounded subset of a validated
 * draft — never fabricated or ungrounded content. groundingMap is
 * always recomputed from what survives truncation, never carried over
 * wholesale.
 */
export function applyBlogPreviewRestriction(
  data: BlogDraftData,
  groundingMap: Record<string, GroundingRef>
): { data: BlogDraftData; groundingMap: Record<string, GroundingRef> } {
  const keptSections = data.sections.slice(0, BLOG_PREVIEW_SECTION_COUNT);
  const hiddenCount = data.sections.length - keptSections.length;
  const keepIds = keptSections.flatMap((section) => section.evidence);

  const preview: BlogDraftData = {
    title: data.title,
    introduction: data.introduction,
    sections: keptSections,
    conclusion:
      hiddenCount > 0
        ? `This is a free preview showing ${keptSections.length} of ${data.sections.length} section(s). Upgrade to unlock the full article, conclusion, and call to action.`
        : data.conclusion,
    callToAction: null,
    unsupportedClaims: [],
  };

  return { data: preview, groundingMap: pickGroundingSubset(groundingMap, keepIds) };
}

export function applySocialPreviewRestriction(
  data: SocialDraftData,
  groundingMap: Record<string, GroundingRef>
): { data: SocialDraftData; groundingMap: Record<string, GroundingRef> } {
  const truncatedBody =
    data.body.length > SOCIAL_PREVIEW_BODY_CHARS
      ? `${data.body.slice(0, SOCIAL_PREVIEW_BODY_CHARS).trimEnd()}… (upgrade to see the full post)`
      : data.body;
  const keepEvidenceIds = data.evidence.slice(0, SOCIAL_PREVIEW_EVIDENCE_COUNT);

  const preview: SocialDraftData = {
    title: data.title,
    hook: data.hook,
    body: truncatedBody,
    callToAction: null,
    hashtags: data.hashtags.slice(0, SOCIAL_PREVIEW_HASHTAG_COUNT),
    evidence: keepEvidenceIds,
    unsupportedClaims: [],
  };

  return { data: preview, groundingMap: pickGroundingSubset(groundingMap, keepEvidenceIds) };
}
