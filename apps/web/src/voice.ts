import { useEffect, useRef, useState } from 'react'

// Voice input. Local Whisper (the server proxies to GCNB_WHISPER_URL, so audio stays on your machine) when
// it's set up; otherwise the browser's built-in speech recognition (Chrome/Safari send audio to their cloud).

type Recognition = {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void
  onerror: (e: { error: string }) => void
  onend: () => void
  start(): void
  stop(): void
  abort(): void
}
const SR: (new () => Recognition) | undefined = (window as never as Record<string, never>).SpeechRecognition ?? (window as never as Record<string, never>).webkitSpeechRecognition

export type Engine = 'whisper' | 'browser' | null
export const voiceEngine = (whisper: boolean): Engine =>
  whisper && !!navigator.mediaDevices && 'MediaRecorder' in window ? 'whisper' : SR ? 'browser' : null

// send: true = send right away, false = drop the text in the box to review, null = cancel.
type Stop = (send: boolean | null) => void
export type Recording = { startedAt: number; text: string; busy: boolean }

export function useVoice(engine: Engine, onText: (text: string, send: boolean) => void) {
  const [rec, setRec] = useState<Recording | null>(null)
  const [error, setError] = useState('')
  const stopRef = useRef<Stop | null>(null)
  const done = useRef(onText)
  done.current = onText

  const finish = (text: string, send: boolean | null) => {
    stopRef.current = null
    setRec(null)
    if (send !== null && text.trim()) done.current(text.trim(), send)
  }

  // If the component holding this hook unmounts mid-recording (e.g. the PiP window closes natively
  // while you're talking), cancel instead of leaving the mic open with nothing to stop it.
  useEffect(() => () => stopRef.current?.(null), [])

  async function start() {
    if (!engine || stopRef.current) return
    setError('')
    let mode: boolean | null = null
    if (engine === 'browser') {
      const r = new SR!()
      Object.assign(r, { continuous: true, interimResults: true, lang: navigator.language })
      let text = ''
      let stopped = false // distinguishes "you pressed stop" from the engine timing out on its own
      r.onresult = (e) => {
        text = Array.from(e.results, (x) => x[0].transcript).join('')
        setRec((s) => s && { ...s, text })
      }
      r.onerror = (e) => e.error !== 'aborted' && e.error !== 'no-speech' && setError(`Mic: ${e.error}`)
      // A silence timeout ends recognition without you touching anything; don't throw away what you said.
      r.onend = () => finish(text, stopped ? mode : false)
      stopRef.current = (send) => ((stopped = true), (mode = send), send === null ? r.abort() : r.stop())
      r.start()
    } else {
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      } catch (err) {
        return setError(`Mic: ${(err as Error).message}`)
      }
      const mr = new MediaRecorder(stream)
      const chunks: Blob[] = []
      mr.ondataavailable = (e) => chunks.push(e.data)
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        if (mode === null) return finish('', null)
        setRec((s) => s && { ...s, text: 'Transcribing…', busy: true })
        const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' })
        try {
          const res = await fetch('/api/transcribe', { method: 'POST', headers: { 'content-type': blob.type }, body: blob })
          const body = await res.json()
          if (!res.ok) throw new Error(body.error ?? res.status)
          finish(body.text, mode)
        } catch (err) {
          setError(`Whisper: ${(err as Error).message}`)
          finish('', null)
        }
      }
      stopRef.current = (send) => ((mode = send), mr.stop())
      mr.start()
    }
    setRec({ startedAt: Date.now(), text: '', busy: false })
  }

  return { rec, error, start, stop: (send: boolean | null) => stopRef.current?.(send) }
}
