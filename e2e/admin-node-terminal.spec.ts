import { test, expect } from '@playwright/test';
import { injectAdminAuth } from './helpers';

test.describe('Admin Node Terminal (ADR-041)', () => {
  test.beforeEach(async ({ page }) => {
    await injectAdminAuth(page);
    await page.goto('/nodes-and-storage?tab=nodes');
    // Wait for the node list to render — the cluster has at least the
    // k3s control-plane node.
    await page.waitForLoadState('networkidle');
  });

  test('first terminal open prompts for step-up despite fresh login', async ({ page }) => {
    // Click the Terminal button on the first Ready node card. The button
    // is only rendered when the node is Ready.
    const terminalButton = page.getByTestId(/^terminal-node-.+-button$/).first();
    await expect(terminalButton).toBeVisible({ timeout: 5_000 });
    await terminalButton.click();

    // Modal opens. Step-up dialog renders because lastStepUpAt is NULL
    // immediately after a fresh login — ADR-041 evolved spec.
    await expect(page.getByTestId('node-terminal-step-up')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/Re-authenticate to open a root shell/i)).toBeVisible();

    // Password field is present (the test admin has password auth).
    const passwordInput = page.getByTestId('node-terminal-step-up-password-input');
    await expect(passwordInput).toBeVisible();
    await passwordInput.fill('admin');
    await page.getByTestId('node-terminal-step-up-password-submit').click();

    // After step-up, the terminal renders. The xterm container is opaque
    // to Playwright but the [BREAK-GLASS] banner is always visible.
    await expect(page.getByTestId('node-terminal-banner')).toBeVisible({ timeout: 5_000 });
  });

  test('modal is not fullscreen — has a visible backdrop', async ({ page }) => {
    const terminalButton = page.getByTestId(/^terminal-node-.+-button$/).first();
    await terminalButton.click();

    const backdrop = page.getByTestId(/^node-terminal-backdrop-/);
    await expect(backdrop).toBeVisible({ timeout: 5_000 });

    const modal = page.getByTestId(/^node-terminal-modal-/);
    const modalBox = await modal.boundingBox();
    const viewport = page.viewportSize();
    expect(modalBox).not.toBeNull();
    expect(viewport).not.toBeNull();
    if (modalBox && viewport) {
      // Modal must NOT take the full viewport — it's centered with max-w-5xl
      // (1024px) and max-h-[85vh].
      expect(modalBox.width).toBeLessThan(viewport.width);
      expect(modalBox.height).toBeLessThan(viewport.height);
    }
  });

  test('backdrop click closes the modal', async ({ page }) => {
    const terminalButton = page.getByTestId(/^terminal-node-.+-button$/).first();
    await terminalButton.click();
    const modal = page.getByTestId(/^node-terminal-modal-/);
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // Click the backdrop (any spot OUTSIDE the modal box).
    const backdrop = page.getByTestId(/^node-terminal-backdrop-/);
    await backdrop.click({ position: { x: 5, y: 5 } });

    await expect(modal).not.toBeVisible({ timeout: 3_000 });
  });

  test('Escape key closes the modal', async ({ page }) => {
    const terminalButton = page.getByTestId(/^terminal-node-.+-button$/).first();
    await terminalButton.click();
    const modal = page.getByTestId(/^node-terminal-modal-/);
    await expect(modal).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('Escape');
    await expect(modal).not.toBeVisible({ timeout: 3_000 });
  });
});
