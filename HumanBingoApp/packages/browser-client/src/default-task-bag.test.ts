import { describe, expect, it } from 'vitest';

import { DEFAULT_TASK_BAG, normalizeTaskBagText } from './default-task-bag.js';

describe('default task bag', () => {
  it('provides 50 prefilled tasks so a grid can open without manual entry', () => {
    expect(DEFAULT_TASK_BAG).toHaveLength(50);
  });

  it('keeps every task non-empty and unique under the server normalization', () => {
    const normalized = DEFAULT_TASK_BAG.map(normalizeTaskBagText);
    expect(normalized.every((text) => text.length > 0)).toBe(true);
    expect(new Set(normalized).size).toBe(50);
  });

  it('fits within the client input limit', () => {
    expect(DEFAULT_TASK_BAG.every((text) => text.length <= 240)).toBe(true);
  });
});