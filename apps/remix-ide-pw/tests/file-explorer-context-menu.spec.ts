import { test, expect } from '@playwright/test'
import { blockCompilerSources, ensureFilePanel, gotoHome } from './helpers'

test.describe('File Explorer context menu placement', () => {
  test('TC-FE-CONTEXT-001: a zero-coordinate context menu stays above the header and Delete is clickable', { tag: '@gate' }, async ({ page }) => {
    await blockCompilerSources(page)
    await gotoHome(page)
    await ensureFilePanel(page)

    const row = page.locator('[data-path="contracts"]').first()
    await row.waitFor({ state: 'visible', timeout: 10_000 })

    // Nightwatch, keyboard context-menu shortcuts, and some assistive tools
    // dispatch contextmenu at (0, 0). This used to put Delete underneath the
    // horizontal TronIDE logo, where WebDriver correctly refused the click.
    await row.dispatchEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: 0,
      clientY: 0
    })

    const menu = page.locator('#menuItemsContainer')
    const deleteItem = page.locator('#menuitemdelete')
    await expect(menu).toBeVisible()
    await expect(deleteItem).toBeVisible()

    const placement = await deleteItem.evaluate((item) => {
      const menu = document.getElementById('menuItemsContainer')
      if (!menu) throw new Error('Context menu was not rendered')
      const header = document.querySelector('.top-header-wrapper')
      const menuBox = menu.getBoundingClientRect()
      const itemBox = item.getBoundingClientRect()
      const headerBox = header && header.getBoundingClientRect()
      const hit = document.elementFromPoint(
        itemBox.left + itemBox.width / 2,
        itemBox.top + itemBox.height / 2
      )
      return {
        insideViewport:
          menuBox.left >= 0 &&
          menuBox.top >= 0 &&
          menuBox.right <= window.innerWidth &&
          menuBox.bottom <= window.innerHeight,
        belowHeader: !headerBox || itemBox.top >= headerBox.bottom,
        hitIsDelete: hit === item || item.contains(hit),
        menuZIndex: Number(window.getComputedStyle(menu).zIndex),
        headerZIndex: header
          ? Number(window.getComputedStyle(header).zIndex)
          : 0
      }
    })

    expect(placement.insideViewport).toBe(true)
    expect(placement.belowHeader).toBe(true)
    expect(placement.hitIsDelete).toBe(true)
    expect(placement.menuZIndex).toBeGreaterThan(placement.headerZIndex)

    await deleteItem.click()
    const deleteDialog = page.locator('[data-id$="ModalDialogContainer-react"]')
      .filter({ hasText: 'Are you sure you want to delete this item?' })
    await expect(deleteDialog).toBeVisible()
    await deleteDialog.locator('.modal-cancel').click()
    await expect(row).toBeVisible()
  })
})
