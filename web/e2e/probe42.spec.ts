import { test, expect, type Page } from '@playwright/test';
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
test('idle rAF baseline under mobile emulation', async ({ page }: { page: Page }): Promise<void> => {
  await page.goto('/#/browse', { waitUntil: 'domcontentloaded' });
  const gaps = await page.evaluate(async (): Promise<number[]> => {
    const out: number[] = [];
    let last = 0;
    await new Promise((resolve): void => {
      const tick = (t: number): void => {
        if (last > 0) out.push(t - last);
        last = t;
        if (out.length >= 60) { resolve(undefined); return; }
        window.requestAnimationFrame(tick);
      };
      window.requestAnimationFrame(tick);
    });
    return out;
  });
  const sorted = [...gaps].sort((a, b): number => a - b);
  console.log('IDLE-BASELINE median=' + sorted[Math.floor(sorted.length / 2)] + ' worst=' + sorted[sorted.length - 1]);
  expect(sorted.length).toBeGreaterThan(10);
});
