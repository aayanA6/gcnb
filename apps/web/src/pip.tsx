import { useEffect, useRef, useState } from 'react'

// Document Picture-in-Picture: an always-on-top mini window that shares this page's JS realm
// (no second socket, no message-passing — the portal's event handlers just run as normal React).
// Not yet in lib.dom.d.ts, so a minimal shape is declared here instead of pulling in a types package.
declare global {
  interface Window {
    documentPictureInPicture?: {
      requestWindow(options?: { width?: number; height?: number }): Promise<Window>
      readonly window: Window | null
    }
  }
}

export const pipSupported = typeof window !== 'undefined' && 'documentPictureInPicture' in window

// Clones every <style> and <link rel=stylesheet> from the main document's <head> into the PiP
// document (Vite dev uses <style> tags, a prod build uses a <link> to /assets/*.css — both copy the
// same way), and mirrors documentElement's style attribute + color-scheme, which is where
// applyTheme() writes the theme's CSS variables. Both stay in sync via MutationObserver so switching
// themes, or Vite HMR touching <head>, reaches the PiP window too.
function useMirrorStyles(win: Window | null) {
  useEffect(() => {
    if (!win) return
    const copyHead = () => {
      win.document.querySelectorAll('[data-pip-style]').forEach((n) => n.remove())
      document.head.querySelectorAll('style, link[rel="stylesheet"]').forEach((node) => {
        const clone = node.cloneNode(true) as HTMLElement
        clone.setAttribute('data-pip-style', '')
        win.document.head.append(clone)
      })
    }
    const copyRootStyle = () => {
      win.document.documentElement.setAttribute('style', document.documentElement.getAttribute('style') ?? '')
      win.document.documentElement.style.colorScheme = document.documentElement.style.colorScheme
    }
    copyHead()
    copyRootStyle()
    win.document.body.style.margin = '0'
    const headObserver = new MutationObserver(copyHead)
    // childList covers Vite's injected <style> tags; attributes covers theme.ts flipping the
    // existing #theme-fonts <link>'s href in place (a theme switch between two already-fonted themes).
    headObserver.observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] })
    const rootObserver = new MutationObserver(copyRootStyle)
    rootObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
    return () => {
      headObserver.disconnect()
      rootObserver.disconnect()
    }
  }, [win])
}

// Opens/closes the PiP window and keeps its styles mirrored. `win` is null until requestWindow()
// resolves and again once the browser (or Expand) closes it — that's the portal's mount signal.
export function usePip(title = 'gcnb') {
  const [win, setWin] = useState<Window | null>(null)
  const winRef = useRef<Window | null>(null)
  const pendingRef = useRef(false) // a requestWindow() already in flight: don't fire a second one
  useMirrorStyles(win)

  const open = () => {
    if (winRef.current) return void winRef.current.focus() // already open: just bring it forward
    if (pendingRef.current || !window.documentPictureInPicture) return
    pendingRef.current = true
    window.documentPictureInPicture
      .requestWindow({ width: 380, height: 560 })
      .then((pipWin) => {
        pipWin.document.title = title
        pipWin.addEventListener('pagehide', () => {
          winRef.current = null
          setWin(null)
        })
        winRef.current = pipWin
        setWin(pipWin)
      })
      .catch(() => {}) // the user dismissed the permission/placement prompt, or the browser refused
      .finally(() => {
        pendingRef.current = false
      })
  }
  const close = () => winRef.current?.close()

  return { win, open, close, supported: pipSupported }
}
