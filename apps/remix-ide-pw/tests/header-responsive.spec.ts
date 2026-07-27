import { test, expect } from '@playwright/test'
import { gotoHome } from './helpers'

const NILE_GENESIS = '0000000000000000d698d4192c56cb6be724a558448e2684802de4d6cd8690dc'
const ACCOUNT = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'

const CONNECTED_TRONLINK = `(() => {
  const account = '${ACCOUNT}'
  window.tronWeb = {
    defaultAddress: { base58: account, hex: '410000000000000000000000000000000000000000' },
    fullNode: { host: 'https://nile.trongrid.io', headers: {} },
    trx: {
      getBlock: async () => ({ blockID: '${NILE_GENESIS}' }),
      getNodeInfo: async () => ({})
    },
    ready: true
  }
  window.tronLink = {
    ready: true,
    tronWeb: window.tronWeb,
    request: async () => [account],
    on: () => {},
    removeListener: () => {}
  }
})()`

test.describe('Responsive top header', () => {
  test('TC-HDR-RESP-002: Settings stays in the activity bar without a duplicate header button', { tag: '@gate' }, async ({ page }) => {
    await gotoHome(page)

    await expect(page.locator('[data-id="headerSettingsButton"]')).toHaveCount(0)
    const activityBarSettings = page.locator('[data-id="verticalIconsKindsettings"]')
    await expect(activityBarSettings).toBeVisible()
    await activityBarSettings.click()
    await expect(page.locator('[data-id="settingsTabThemePanel"]')).toBeVisible({ timeout: 10_000 })
  })

  test('TC-HDR-RESP-001: connected-wallet actions never cover the centered workspace controls', { tag: '@gate' }, async ({ page }) => {
    await page.addInitScript(CONNECTED_TRONLINK)
    await gotoHome(page)

    const walletButton = page.locator('[data-id="headerWalletConnect"]')
    await expect(walletButton).toContainText('T9yD14…HxuWwb · Nile', { timeout: 10_000 })
    await expect(walletButton).not.toContainText('Wallet T')

    // Closing the AI panel adds its restore icon to the header, producing the
    // widest real right-hand cluster without fabricating DOM in the test.
    await page.locator('[data-id="headerToggleAiPanel"]').click()
    await expect(page.locator('.ai-show-btn')).toBeVisible({ timeout: 5_000 })

    for (const width of [1920, 1601, 1600, 1440, 1366, 1201, 1200, 1024]) {
      await page.setViewportSize({ width, height: 768 })

      const layout = await page.evaluate(() => {
        const box = (element: Element) => {
          const rect = element.getBoundingClientRect()
          return { left: rect.left, right: rect.right, width: rect.width }
        }
        const workspace = document.querySelector('[data-id="headerWorkspaceMenu"]') as HTMLElement
        const rightCluster = document.querySelector('.header-right-cluster') as HTMLElement
        const leftCluster = document.querySelector('.top-header-wrapper > div:first-child') as HTMLElement
        const actionButtons = Array.from(document.querySelectorAll('.header-action-btn'))
        const visibleChildren = Array.from(rightCluster.children)
          .filter((element) => window.getComputedStyle(element).display !== 'none')
          .map(box)

        return {
          viewportWidth: window.innerWidth,
          workspaceVisible: window.getComputedStyle(workspace).display !== 'none',
          workspace: box(workspace),
          rightCluster: box(rightCluster),
          leftCluster: box(leftCluster),
          actionWidths: actionButtons.map((button) => box(button).width),
          childOverlaps: visibleChildren.slice(0, -1).map((child, index) =>
            child.right - visibleChildren[index + 1].left)
        }
      })

      expect(layout.rightCluster.right, `right edge at ${width}px`).toBeLessThanOrEqual(layout.viewportWidth + 0.5)
      expect(layout.rightCluster.left, `left/right clusters at ${width}px`).toBeGreaterThanOrEqual(layout.leftCluster.right)
      expect(Math.max(0, ...layout.childOverlaps), `right-side controls at ${width}px`).toBeLessThanOrEqual(0.5)
      expect(Math.min(...layout.actionWidths), `action target width at ${width}px`).toBeGreaterThanOrEqual(29.5)

      if (layout.workspaceVisible) {
        expect(layout.rightCluster.left - layout.workspace.right, `workspace gap at ${width}px`).toBeGreaterThanOrEqual(8)
      }
    }

    // The constrained wrappers must not trade overlap for inaccessible menus.
    await page.setViewportSize({ width: 1366, height: 768 })
    await page.locator('[data-id="headerWorkspaceDropdown"]').click()
    await expect(page.locator('.header-workspace-dropdown')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.header-workspace-dropdown')).toBeHidden()

    await walletButton.click()
    const walletMenu = page.locator('[data-id="headerWalletMenu"]')
    await expect(walletMenu).toBeVisible()
    const walletMenuBox = await walletMenu.boundingBox()
    expect(walletMenuBox).not.toBeNull()
    expect(walletMenuBox!.x).toBeGreaterThanOrEqual(0)
    expect(walletMenuBox!.x + walletMenuBox!.width).toBeLessThanOrEqual(1366)
  })
})
