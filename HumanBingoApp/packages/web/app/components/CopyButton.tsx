'use client';

import { useState } from 'react';

export function CopyButton({ value, label = 'Copy code' }: { value: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'success' | 'error'>('idle');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState('success');
    } catch {
      setState('error');
    }
  };

  return (
    <button
      type="button"
      className={`action-button action-button--quiet${state === 'success' ? ' action-button--success' : ''}`}
      onClick={() => void copy()}
      aria-live="polite"
    >
      {state === 'success' ? 'Copied' : state === 'error' ? 'Copy unavailable' : label}
    </button>
  );
}
