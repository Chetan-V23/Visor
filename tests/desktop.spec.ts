import { resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

let app: ElectronApplication
let page: Page
let rendererErrors: string[]

test.beforeEach(async () => {
  rendererErrors = []
  app = await electron.launch({ args: [resolve('apps/desktop/out/main/index.js')] })
  page = await app.firstWindow()
  page.on('pageerror', (error) => rendererErrors.push(error.message))
})

test.afterEach(async () => {
  await app?.close()
  expect(rendererErrors).toEqual([])
})

test('shows the Step 1 diagram and method signature on hover', async () => {
  await expect(page.getByRole('heading', { name: 'Refactor the checkout flow' })).toBeVisible()
  await expect(page.getByTestId('class-node')).toHaveCount(3)
  await expect(page.locator('.react-flow__edge')).toHaveCount(2)
  await expect(page.getByTestId('change-entry')).toHaveCount(4)
  await expect(page.getByTestId('change-entry').first()).toContainText('Change 4')
  await page.getByRole('button', { name: 'added add_item(self, item)', exact: true }).hover()
  await expect(page.getByRole('tooltip')).toContainText('def add_item(self, item: Item) -> None')
  await expect(page.getByRole('tooltip')).toContainText('Add an item to the cart and update its total.')
  await page.mouse.move(5, 5)
  await expect(page.locator('.method-tooltip')).toHaveCount(0)
})

test('uses the requested colors and keeps the renderer isolated', async () => {
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(242, 212, 121)')
  await expect(page.locator('.diagram-panel')).toHaveCSS('background-color', 'rgb(217, 122, 43)')
  await expect(page.locator('.method-added').first()).toHaveCSS('color', 'rgb(111, 175, 79)')
  await expect(page.locator('.method-deleted').first()).toHaveCSS('color', 'rgb(196, 74, 58)')
  await expect(page.locator('.method-unchanged').first()).toHaveCSS('color', 'rgb(0, 0, 0)')
  await expect(page.locator('.method-unchanged').first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  expect(await page.evaluate(() => 'require' in window)).toBe(false)
  const preferences = await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0]?.webContents
    if (!contents || !('getLastWebPreferences' in contents) || typeof contents.getLastWebPreferences !== 'function') {
      throw new Error('Electron did not expose runtime web preferences for the security check.')
    }
    const result: unknown = contents.getLastWebPreferences()
    return result
  })
  expect(preferences).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false })
})

test('supports zoom controls, change selection, and Settings', async () => {
  const before = await page.getByRole('status', { name: 'Zoom level' }).textContent()
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await expect(page.getByRole('status', { name: 'Zoom level' })).not.toHaveText(before ?? '')
  await page.getByRole('button', { name: 'Fit diagram', exact: true }).click()
  await page.getByTestId('change-entry').nth(2).click()
  await expect(page.getByTestId('change-entry').nth(2)).toHaveAttribute('aria-current', 'step')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByRole('dialog')).toContainText('#C44A3A')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('fits desktop and narrow desktop windows without overflow', async () => {
  for (const [width, height] of [[1400, 900], [800, 650]]) {
    await app.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height)
    }, { width: width ?? 800, height: height ?? 650 })
    await page.getByRole('button', { name: 'Fit diagram', exact: true }).click()
    await expect(page.getByTestId('class-node')).toHaveCount(3)
    await expect.poll(() => page.evaluate(() => {
      const canvas = document.querySelector('.diagram-canvas')?.getBoundingClientRect()
      return canvas && [...document.querySelectorAll('.class-node')].every((node) => {
        const bounds = node.getBoundingClientRect()
        return bounds.left >= canvas.left && bounds.right <= canvas.right && bounds.top >= canvas.top && bounds.bottom <= canvas.bottom
      })
    })).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.mouse.move(0, 0)
    await page.screenshot({ path: `test-results/visor-${width}.png`, fullPage: true })
  }
})

test('supports keyboard tooltips and the mobile renderer layout', async () => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Fit diagram', exact: true }).click()
  await expect(page.getByTestId('class-node')).toHaveCount(3)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const method = page.getByRole('button', { name: 'added add_item(self, item)', exact: true })
  await method.focus()
  await expect(page.locator('.method-tooltip')).toContainText('def add_item(self, item: Item) -> None')
  await page.keyboard.press('Escape')
  await expect(page.locator('.method-tooltip')).toHaveCount(0)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('button', { name: 'Close settings', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.mouse.move(0, 0)
  await page.screenshot({ path: 'test-results/visor-mobile.png', fullPage: true })
})