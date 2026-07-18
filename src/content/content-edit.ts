export const CONTENT_EDIT_OPERATIONS = ['append', 'prepend', 'insert_before', 'insert_after', 'replace'] as const;
export type ContentEditOperation = typeof CONTENT_EDIT_OPERATIONS[number];

export type ContentEditParams = {
  operation: ContentEditOperation;
  value: string;
  target_text?: string;
  occurrence?: number;
  content_format?: 'auto' | 'markdown' | 'html' | 'blocks';
  convert_to_blocks?: boolean;
};

export const validateContentEdit = (edit: ContentEditParams): void => {
  const targetedOperations = new Set<ContentEditOperation>(['insert_before', 'insert_after', 'replace']);

  if (targetedOperations.has(edit.operation) && !edit.target_text) {
    throw new Error(`content_edit.target_text is required for ${edit.operation}`);
  }
};

const getTargetMatchIndex = (content: string, targetText: string, occurrence?: number): number => {
  const matches: number[] = [];
  let fromIndex = 0;

  while (true) {
    const matchIndex = content.indexOf(targetText, fromIndex);
    if (matchIndex === -1) break;

    matches.push(matchIndex);
    fromIndex = matchIndex + targetText.length;
  }

  if (matches.length === 0) {
    throw new Error('content_edit.target_text was not found in the existing content');
  }

  if (occurrence === undefined) {
    if (matches.length > 1) {
      throw new Error(`content_edit.target_text matched ${matches.length} locations. Provide content_edit.occurrence to disambiguate.`);
    }
    return matches[0];
  }

  if (!Number.isInteger(occurrence) || occurrence < 1) {
    throw new Error('content_edit.occurrence must be a positive integer');
  }

  const resolvedIndex = matches[occurrence - 1];
  if (resolvedIndex === undefined) {
    throw new Error(`content_edit.occurrence ${occurrence} is out of range for ${matches.length} matches`);
  }

  return resolvedIndex;
};

export const applyContentEdit = (existingContent: string, edit: ContentEditParams): string => {
  validateContentEdit(edit);

  if (edit.operation === 'append') return `${existingContent}${edit.value}`;
  if (edit.operation === 'prepend') return `${edit.value}${existingContent}`;

  const targetText = edit.target_text as string;
  const targetIndex = getTargetMatchIndex(existingContent, targetText, edit.occurrence);

  if (edit.operation === 'insert_before') {
    return `${existingContent.slice(0, targetIndex)}${edit.value}${existingContent.slice(targetIndex)}`;
  }

  const targetEnd = targetIndex + targetText.length;
  if (edit.operation === 'insert_after') {
    return `${existingContent.slice(0, targetEnd)}${edit.value}${existingContent.slice(targetEnd)}`;
  }

  return `${existingContent.slice(0, targetIndex)}${edit.value}${existingContent.slice(targetEnd)}`;
};
