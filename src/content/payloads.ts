import { AdaptedWriteInput } from '../adapters/types.js';
import { removeUndefinedValues } from './utils.js';

export function buildBaseContentPayload(
  input: AdaptedWriteInput,
  operation: 'create' | 'update'
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  if (operation === 'create' || input.title !== undefined) payload.title = input.title;
  if (operation === 'create' || input.content !== undefined) payload.content = input.content;
  if (operation === 'create' || input.status !== undefined) payload.status = input.status;
  if (input.excerpt !== undefined) payload.excerpt = input.excerpt;
  if (input.slug !== undefined) payload.slug = input.slug;
  if (input.author !== undefined) payload.author = input.author;
  if (input.parent !== undefined) payload.parent = input.parent;
  if (input.featured_media !== undefined) payload.featured_media = input.featured_media;
  if (input.format !== undefined) payload.format = input.format;
  if (input.menu_order !== undefined) payload.menu_order = input.menu_order;
  if (input.categories !== undefined) payload.categories = input.categories;
  if (input.tags !== undefined) payload.tags = input.tags;
  if (input.meta !== undefined) payload.meta = input.meta;

  if (input.custom_fields) {
    Object.assign(payload, input.custom_fields);
  }

  return removeUndefinedValues(payload);
}
