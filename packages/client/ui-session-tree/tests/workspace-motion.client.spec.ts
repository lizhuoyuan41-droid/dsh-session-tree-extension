// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { installWorkspaceMotion } from '../src/client/workspace-motion.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const dispose of cleanups.splice(0)) dispose()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

function rect(top: number, height = 30): DOMRect {
  return { x: 10, y: top, top, left: 10, right: 210, bottom: top + height, width: 200, height, toJSON: () => ({}) }
}

function setup() {
  document.body.innerHTML = '<div role="tree"><section><div role="treeitem" data-row-key="workspace:a" aria-expanded="false">workspace</div></section><section><div data-row-key="workspace:b">next workspace</div></section></div>'
  const tree = document.querySelector<HTMLElement>('[role="tree"]')!
  const header = tree.querySelector<HTMLElement>('[data-row-key="workspace:a"]')!
  const next = tree.querySelector<HTMLElement>('[data-row-key="workspace:b"]')!
  let nextTop = 160
  vi.spyOn(header, 'getBoundingClientRect').mockImplementation(() => rect(100))
  vi.spyOn(next, 'getBoundingClientRect').mockImplementation(() => rect(nextTop))
  const frames = new Map<number, FrameRequestCallback>()
  let id = 0
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => { frames.set(++id, cb); return id })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(key => { frames.delete(key) })
  const play = vi.fn(() => ({ cancel: vi.fn(), onfinish: null } as unknown as Animation))
  Object.defineProperty(next, 'animate', { configurable: true, value: play })
  cleanups.push(installWorkspaceMotion(document))
  return {
    tree, header, next, play,
    setNextTop: (top: number) => { nextTop = top },
    flush: () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(cb => cb(0)) },
    addRow: () => {
      const row = document.createElement('div')
      row.dataset.rowKey = 'session:new'
      row.setAttribute('role', 'treeitem')
      header.parentElement!.append(row)
      vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => rect(135))
      Object.defineProperty(row, 'animate', { configurable: true, value: play })
      return row
    },
  }
}

it('new sessions enter at their final position while existing workspace rows start at their pre-click position', () => {
  const scene = setup()
  scene.header.click()
  const row = scene.addRow()
  scene.header.setAttribute('aria-expanded', 'true')
  scene.setNextTop(300)
  // A stale native transform can put a newly inserted row above its workspace.
  const cancel = vi.fn()
  Object.defineProperty(row, 'getAnimations', { value: () => [{ cancel, effect: { target: row, getKeyframes: () => [{ transform: 'translateY(-135px)' }, { transform: 'none' }] } }] })
  scene.flush()
  expect(cancel).toHaveBeenCalledOnce()
  const newRowCall = scene.play.mock.calls.find((_, i) => scene.play.mock.contexts[i] === row)
  expect(newRowCall?.[0]).toEqual([{ opacity: 0 }, { opacity: 1 }])
  const nextCall = scene.play.mock.calls.find((_, i) => scene.play.mock.contexts[i] === scene.next)
  expect(nextCall?.[0]).toEqual([{ transform: 'translate(0px, -140px)' }, { transform: 'translate(0, 0)' }])
})

it('removes an entrant translation before the next animation frame', async () => {
  const scene = setup()
  scene.header.click()
  const row = scene.addRow()
  const cancel = vi.fn()
  Object.defineProperty(row, 'getAnimations', { value: () => [{ cancel, effect: { target: row, getKeyframes: () => [{ transform: 'translateY(-135px)' }, { transform: 'none' }] } }] })
  scene.header.setAttribute('aria-expanded', 'true')
  await Promise.resolve()
  expect(cancel).toHaveBeenCalledOnce()
  expect(scene.play).not.toHaveBeenCalled()
})

it('ignores zero-sized old rows instead of treating viewport origin as an animation start', () => {
  const scene = setup()
  const row = scene.addRow()
  vi.mocked(row.getBoundingClientRect).mockReturnValue(rect(0, 0))
  scene.header.click()
  vi.mocked(row.getBoundingClientRect).mockReturnValue(rect(135))
  scene.header.setAttribute('aria-expanded', 'true')
  scene.flush()
  expect(scene.play.mock.calls[0]?.[0]).toEqual([{ opacity: 0 }, { opacity: 1 }])
})

it('preserves unrelated row animations and ignores clicks on workspace action buttons', () => {
  const scene = setup()
  const cancel = vi.fn()
  Object.defineProperty(scene.next, 'getAnimations', { value: () => [{ cancel, effect: { target: scene.next, getKeyframes: () => [{ opacity: 0 }, { opacity: 1 }] } }] })
  const button = document.createElement('button')
  scene.header.append(button)
  button.click()
  scene.flush()
  expect(scene.play).not.toHaveBeenCalled()
  scene.header.click()
  scene.header.setAttribute('aria-expanded', 'true')
  scene.setNextTop(300)
  scene.flush()
  expect(cancel).not.toHaveBeenCalled()
})

it('does not animate if the workspace state did not change', () => {
  const scene = setup()
  scene.header.click()
  scene.setNextTop(300)
  scene.flush()
  expect(scene.play).not.toHaveBeenCalled()
})

it('cancels pending work and owned animations on disposal', () => {
  const scene = setup()
  scene.header.click()
  scene.header.setAttribute('aria-expanded', 'true')
  scene.setNextTop(300)
  scene.flush()
  const animation = scene.play.mock.results[0]!.value
  cleanups.splice(0).forEach(dispose => dispose())
  expect(animation.cancel).toHaveBeenCalledOnce()
  scene.header.click()
  scene.flush()
  expect(scene.play).toHaveBeenCalledOnce()
})
