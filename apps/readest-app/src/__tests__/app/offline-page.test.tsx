import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import Offline from '@/app/offline/page';

const originalLocation = window.location;

afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'location', { value: originalLocation, writable: true });
});

describe('Offline fallback page', () => {
  it('reloads into the app once the connection comes back', () => {
    const reload = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, reload },
      writable: true,
    });
    render(<Offline />);
    window.dispatchEvent(new Event('online'));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
