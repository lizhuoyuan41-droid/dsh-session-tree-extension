// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { nativeTurnForSeq, navigateNativeTurn, waitForVisiblePage } from '../src/client/node-navigation.ts'

describe('native turn resolution', () => {
 it('uses the Session event turn instead of the prompt ordinal', () => {
  // Oracle taken from the real session log: turns 4 and 5 had no typed prompt,
  // so the 4th prompt (a lone image) is native turn 6.
  const entries = [1, 2, 3, 6].map(turn => ({
   type: 'event',
   event: { type: 'turn/start', seq: turn * 100, data: { turn } },
  }))
  expect(nativeTurnForSeq(entries, 610)).toBe(6)
  expect(nativeTurnForSeq(entries, 340)).toBe(3)
  expect(nativeTurnForSeq(entries, 50)).toBeUndefined()
 })
})

describe('native turn navigation', () => {
 it('waits for the target conversation and never clicks the previous session rail', async () => {
  const old = document.createElement('nav');old.setAttribute('aria-label','轮次导航');old.innerHTML='<button aria-label="跳转到第 2 轮"></button>';document.body.append(old)
  const previous = vi.fn();old.querySelector('button')!.onclick=previous
  let target: HTMLElement | null = null
  const promise = navigateNativeTurn({turn:2,getRoot:()=>target,timeoutMs:500})
  const root=document.createElement('section');root.innerHTML='<nav aria-label="轮次导航"><button aria-label="加载并跳转到第 2 轮"></button></nav>'
  const clicked=vi.fn();root.querySelector('button')!.onclick=clicked
  target=root;document.body.append(root)
  await promise
  expect(clicked).toHaveBeenCalledOnce();expect(previous).not.toHaveBeenCalled();old.remove();root.remove()
 })
 it('reports a missing exact turn instead of jumping to a neighbouring turn', async()=>{
  const root=document.createElement('section');root.innerHTML='<nav aria-label="Turn navigation"><button aria-label="Jump to turn 1"></button></nav>';document.body.append(root)
  const clicked=vi.fn();root.querySelector('button')!.onclick=clicked
  await expect(navigateNativeTurn({turn:7,getRoot:()=>root,timeoutMs:15})).rejects.toThrow('7')
  expect(clicked).not.toHaveBeenCalled();root.remove()
 })
 it.each(['Zum Turn 4 springen','Aller au tour 4','ターン 4 に移動','Saltar al turno 4'])('reuses the native rail in locale %s',async(label)=>{
  const root=document.createElement('section');const nav=document.createElement('nav');const button=document.createElement('button');button.setAttribute('aria-label',label);nav.append(button);root.append(nav);document.body.append(root)
  const clicked=vi.fn();button.onclick=clicked
  await navigateNativeTurn({turn:4,getRoot:()=>root,timeoutMs:50})
  expect(clicked).toHaveBeenCalledOnce();root.remove()
 })
 it('cancels a superseded navigation',async()=>{
  const controller=new AbortController()
  const promise=navigateNativeTurn({turn:3,getRoot:()=>null,signal:controller.signal,timeoutMs:500})
  controller.abort();await expect(promise).rejects.toMatchObject({name:'AbortError'})
 })
})

describe('long-transcript rail scrolling', () => {
  it('centers the target mark before clicking it', async () => {
    const root = document.createElement('section')
    root.innerHTML = '<nav aria-label="轮次导航"><div class="scroller"><button aria-label="跳转到第 40 轮"></button></div></nav>'
    document.body.append(root)
    const mark = root.querySelector('button')!
    const scrollIntoView = vi.fn()
    mark.scrollIntoView = scrollIntoView
    const click = vi.fn()
    mark.onclick = click
    await navigateNativeTurn({ turn: 40, getRoot: () => root, timeoutMs: 200 })
    expect(scrollIntoView).toHaveBeenCalled()
    expect(click).toHaveBeenCalledOnce()
    root.remove()
  })
})

describe('verified landing', () => {
  function stage(options: { revert?: () => void } = {}) {
    const root = document.createElement('section')
    const nav = document.createElement('nav')
    nav.setAttribute('aria-label', '轮次导航')
    const scroller = document.createElement('div')
    scroller.className = 'scroller'
    scroller.dataset.conversationSession = 'target'
    const flow = document.createElement('div')
    flow.setAttribute('data-chat-flow', '')
    const row = document.createElement('div')
    row.dataset.chatFlowKey = '5:input-message'
    row.dataset.chatFlowKind = 'user'
    row.textContent = 'target message'
    flow.append(row)
    scroller.append(flow)
    root.append(nav, scroller)
    document.body.append(root)
    const marks = [2, 5].map(turn => {
      const mark = document.createElement('button')
      mark.setAttribute('aria-label', `跳转到第 ${turn} 轮`)
      nav.append(mark)
      return mark
    })
    // jsdom has no layout: provide the geometry the verifier relies on.
    root.getBoundingClientRect = () => ({ width: 400, height: 600, top: 0, bottom: 600, left: 0, right: 400, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    nav.getBoundingClientRect = () => ({ width: 28, height: 420, top: 0, bottom: 420, left: 0, right: 28, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    scroller.getBoundingClientRect = () => ({ width: 400, height: 400, top: 0, bottom: 400, left: 0, right: 400, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 2000 })
    flow.getBoundingClientRect = () => ({ width: 400, height: 2000, top: 0, bottom: 2000, left: 0, right: 400, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    row.getBoundingClientRect = () => ({ width: 400, height: 20, top: 100, bottom: 120, left: 0, right: 400, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    const clicked: number[] = []
    for (const [index, mark] of marks.entries()) {
      mark.onclick = () => {
        const turn = index === 0 ? 2 : 5
        clicked.push(turn)
        for (const other of marks) other.removeAttribute('aria-current')
        mark.setAttribute('aria-current', 'true')
        scroller.scrollTop = turn === 5 ? 900 : 100
        options.revert?.()
      }
    }
    return { root, marks, clicked, cleanup: () => root.remove() }
  }

  it('accepts only after the target turn is visible and the page settles', async () => {
    const fixture = stage()
    await navigateNativeTurn({ turn: 5, getRoot: () => fixture.root, verify: true, timeoutMs: 2000, settleMs: 150, retryMs: 400 })
    expect(fixture.clicked).toContain(5)
    fixture.cleanup()
  })

  it('requires the clicked message text to be visible when known', async () => {
    const fixture = stage()
    await navigateNativeTurn({ turn: 5, getRoot: () => fixture.root, verify: true, sessionId: 'target', expectText: 'target message', timeoutMs: 2000, settleMs: 120 })
    fixture.cleanup()
  })

  it('rejects a rail match when the clicked message is not on screen', async () => {
    const fixture = stage()
    await expect(navigateNativeTurn({ turn: 5, getRoot: () => fixture.root, verify: true, expectText: 'a different message', timeoutMs: 900, settleMs: 100, retryMs: 300, maxClicks: 1 }))
      .rejects.toThrow('目标消息不在可视区域')
    fixture.cleanup()
  })

  it('re-clicks after the native page restores an older position over the landing', async () => {
    let reverted = false
    const fixture = stage()
    const first = fixture.marks[1]!
    const original = first.onclick
    first.onclick = (event) => {
      original?.call(first, event)
      if (reverted) return
      reverted = true
      // Native `reading.restore()` runs after the first rail click.
      // Deterministic restore: run before the 200ms settle window can accept
      // the first landing, otherwise faster runners accept it before this timer.
      window.setTimeout(() => {
        for (const mark of fixture.marks) mark.removeAttribute('aria-current')
        fixture.marks[0]!.setAttribute('aria-current', 'true')
        fixture.root.querySelector<HTMLElement>('.scroller')!.scrollTop = 50
      }, 0)
    }
    await navigateNativeTurn({ turn: 5, getRoot: () => fixture.root, verify: true, timeoutMs: 3000, settleMs: 200, retryMs: 500 })
    expect(fixture.clicked.filter(turn => turn === 5).length).toBeGreaterThanOrEqual(2)
    expect(fixture.marks[1]!.getAttribute('aria-current')).toBe('true')
    fixture.cleanup()
  })

  it('fails loudly when the page keeps restoring the wrong turn', async () => {
    const fixture = stage()
    for (const mark of fixture.marks) {
      mark.onclick = () => {
        for (const other of fixture.marks) other.removeAttribute('aria-current')
        fixture.marks[0]!.setAttribute('aria-current', 'true')
      }
    }
    await expect(navigateNativeTurn({ turn: 5, getRoot: () => fixture.root, verify: true, timeoutMs: 1200, settleMs: 100, retryMs: 250, maxClicks: 2 }))
      .rejects.toThrow('第 5 轮')
    fixture.cleanup()
  })

  it('ignores a retained hidden page whose rail also exposes the turn', async () => {
    const fixture = stage()
    const hidden = document.createElement('section')
    hidden.innerHTML = '<nav aria-label="轮次导航"><button aria-label="跳转到第 5 轮"></button></nav>'
    document.body.append(hidden)
    const hiddenClick = vi.fn()
    hidden.querySelector('button')!.onclick = hiddenClick
    await navigateNativeTurn({ turn: 5, getRoot: () => fixture.root, verify: true, timeoutMs: 2000, settleMs: 120 })
    expect(hiddenClick).not.toHaveBeenCalled()
    expect(fixture.clicked).toContain(5)
    fixture.cleanup(); hidden.remove()
  })
})

describe('short transcripts without a scrolling ancestor', () => {
  function shortTranscript() {
    const root = document.createElement('section')
    root.dataset.conversationSession = 'short'
    const scroller = document.createElement('div')
    scroller.setAttribute('data-conversation-scroll', '')
    const flow = document.createElement('div')
    flow.setAttribute('data-chat-flow', '')
    const row = document.createElement('div')
    row.setAttribute('data-chat-flow-kind', 'user')
    row.dataset.chatFlowKey = '1:input-message'
    row.textContent = 'short message'
    flow.append(row)
    scroller.append(flow)
    root.append(scroller)
    document.body.append(root)
    const rect = (value: { width: number; height: number; top: number; bottom: number; left: number; right: number }) =>
      ({ ...value, x: value.left, y: value.top, toJSON: () => ({}) }) as DOMRect
    root.getBoundingClientRect = () => rect({ width: 400, height: 600, top: 0, bottom: 600, left: 0, right: 400 })
    scroller.getBoundingClientRect = () => rect({ width: 400, height: 400, top: 0, bottom: 400, left: 0, right: 400 })
    flow.getBoundingClientRect = () => rect({ width: 400, height: 60, top: 0, bottom: 60, left: 0, right: 400 })
    row.getBoundingClientRect = () => rect({ width: 400, height: 20, top: 10, bottom: 30, left: 0, right: 400 })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 400 })
    Object.defineProperty(flow, 'clientHeight', { configurable: true, value: 60 })
    Object.defineProperty(flow, 'scrollHeight', { configurable: true, value: 60 })
    return { root, cleanup: () => root.remove() }
  }

  it('finds the visible transcript even when the content does not overflow', async () => {
    const fixture = shortTranscript()
    await expect(waitForVisiblePage({ sessionId: 'short', timeoutMs: 400, quietMs: 30 }))
      .resolves.toMatchObject({})
    fixture.cleanup()
  })

  it('accepts an already-visible landing when the host renders no turn rail', async () => {
    const fixture = shortTranscript()
    await expect(navigateNativeTurn({
      turn: 1,
      getRoot: () => fixture.root,
      verify: true,
      sessionId: 'short',
      expectText: 'short message',
      timeoutMs: 800,
      settleMs: 100,
      retryMs: 200,
    })).resolves.toBeUndefined()
    fixture.cleanup()
  })
})
