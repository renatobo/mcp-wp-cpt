const NON_TAXONOMY_OBJECT_FIELDS = new Set(['organizers', 'organizer', 'related_events', 'faqs']);

export const normalizeEmbeddedTerms = (value: unknown): any[] => {
  if (!Array.isArray(value)) return [];

  return value.map((entry) => {
    if (typeof entry === 'string') return { name: entry };
    if (!entry || typeof entry !== 'object') return { name: String(entry) };

    const term = entry as Record<string, unknown>;
    return {
      ...(term.term_id !== undefined ? { id: term.term_id } : {}),
      ...(term.name !== undefined ? { name: term.name } : {}),
      ...(term.slug !== undefined ? { slug: term.slug } : {})
    };
  });
};

export const isEmbeddedTermField = (key: string, value: unknown): boolean => {
  if (!Array.isArray(value) || value.length === 0) return false;
  if (value.every((entry) => typeof entry === 'string')) return true;
  if (NON_TAXONOMY_OBJECT_FIELDS.has(key)) return false;

  return value.every((entry) => entry && typeof entry === 'object' && 'term_id' in entry);
};

const fieldToTaxonomyBase = (key: string): string => {
  const stripped = key.endsWith('_terms') ? key.slice(0, -'_terms'.length) : key;
  return stripped === 'tag' || stripped === 'tags' ? 'post_tag' : stripped;
};

const embeddedFieldNames = (taxonomyBase: string): { label: string; enriched: string } => {
  if (taxonomyBase === 'post_tag') return { label: 'tags', enriched: 'tag_terms' };
  return { label: taxonomyBase, enriched: `${taxonomyBase}_terms` };
};

export const extractPluginObjectTerms = (content: any, taxonomy?: string): Record<string, any[]> => {
  const terms: Record<string, any[]> = {};
  if (!content || typeof content !== 'object') return terms;

  if (taxonomy) {
    const { label, enriched } = embeddedFieldNames(taxonomy);
    const value = isEmbeddedTermField(enriched, content[enriched])
      ? content[enriched]
      : isEmbeddedTermField(label, content[label])
        ? content[label]
        : undefined;
    const normalized = value ? normalizeEmbeddedTerms(value) : [];
    if (normalized.length > 0) terms[taxonomy] = normalized;
    return terms;
  }

  const chosen = new Map<string, { value: unknown; enriched: boolean }>();
  for (const [key, value] of Object.entries(content)) {
    if (!isEmbeddedTermField(key, value)) continue;

    const enriched = key.endsWith('_terms');
    const base = fieldToTaxonomyBase(key);
    const existing = chosen.get(base);
    if (!existing || (enriched && !existing.enriched)) {
      chosen.set(base, { value, enriched });
    }
  }

  for (const [base, { value }] of chosen) {
    terms[base] = normalizeEmbeddedTerms(value);
  }

  return terms;
};
