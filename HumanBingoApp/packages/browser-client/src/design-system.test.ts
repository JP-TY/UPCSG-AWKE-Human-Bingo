import { SquareStatus } from '@human-bingo/domain';
import { describe, expect, it } from 'vitest';
import { designSystemCss, getStatusToken } from './design-system.js';

describe('design system tokens', () => {
  it('communicates every square status with a label, icon, and non-color pattern', () => {
    const statuses = [
      SquareStatus.Unverified,
      SquareStatus.Pending,
      SquareStatus.Rejected,
      SquareStatus.Verified,
    ];
    for (const status of statuses) {
      const token = getStatusToken(status);
      expect(token.label).toBeTruthy();
      expect(token.icon).toBeTruthy();
      expect(token.pattern).toBeTruthy();
      expect(token.className).toContain('status--');
    }
  });

  it('provides responsive and keyboard-visible primitives', () => {
    const css = designSystemCss();
    expect(css).toContain(':focus-visible');
    expect(css).toContain('min-width: 320px');
    expect(css).toContain('grid-template-columns');
    expect(css).toContain('responsive-grid');
    expect(css).toContain('max-height: calc(100dvh - 2rem)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
