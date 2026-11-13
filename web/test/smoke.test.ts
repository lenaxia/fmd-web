import { describe, expect, it } from 'vitest';
import { PLANNED_VIEWS, SPA_MOUNT_ID, webAppInfo } from '../src/index.js';

describe('web placeholder', (): void => {
  it('exposes the mount id and planned views', (): void => {
    expect(SPA_MOUNT_ID).toBe('root');
    expect(PLANNED_VIEWS).toEqual([
      'Browse', 'Manga', 'Favorites', 'Downloads', 'Settings',
    ]);
    expect(webAppInfo().status).toBe('placeholder');
    expect(webAppInfo().views).toHaveLength(5);
  });
});
