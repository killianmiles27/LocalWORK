import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

const RATE = 16000;
const MIN_SECONDS = 0.4; // shorter than this is an accidental tap

type Rec = { stop: () => Float32Array };

async function startRecorder(): Promise<Rec> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const ctx = new AudioContext({ sampleRate: RATE });
  const src = ctx.createMediaStreamSource(stream);
  const node = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  node.onaudioprocess = (e) => { chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
  src.connect(node);
  node.connect(ctx.destination);
  return {
    stop() {
      node.onaudioprocess = null;
      node.disconnect();
      src.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
      const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
      let o = 0;
      for (const c of chunks) { out.set(c, o); o += c.length; }
      return out;
    },
  };
}

function toWav(pcm: Float32Array): Uint8Array {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

/** Hold-to-talk: `press()` starts recording, `release()` stops and transcribes. Ctrl+Space does the same from the keyboard. */
export function useVoice(onText: (t: string) => void, onError: (m: string) => void) {
  const [available, setAvailable] = useState(false);
  const [detail, setDetail] = useState("");
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const rec = useRef<Rec | null>(null);
  const starting = useRef(false);
  const wantStop = useRef(false);
  const cb = useRef({ onText, onError });
  cb.current = { onText, onError };

  useEffect(() => {
    invoke<{ available: boolean; detail: string }>("voice_status")
      .then((s) => { setAvailable(s.available); setDetail(s.detail); })
      .catch(() => {});
  }, []);

  const finish = useCallback(async () => {
    const r = rec.current;
    rec.current = null;
    setRecording(false);
    if (!r) return;
    const pcm = r.stop();
    if (pcm.length < RATE * MIN_SECONDS) return;
    setBusy(true);
    try {
      const t = await invoke<string>("voice_transcribe", toWav(pcm));
      if (t.trim()) cb.current.onText(t.trim());
      else cb.current.onError("I didn't catch any speech — try again, a little closer to the mic.");
    } catch (e) {
      cb.current.onError(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const press = useCallback(async () => {
    if (rec.current || starting.current || busy || !available) return;
    starting.current = true;
    wantStop.current = false;
    try {
      rec.current = await startRecorder();
      setRecording(true);
    } catch (e) {
      cb.current.onError("Can't use the microphone: " + String((e as Error)?.message ?? e));
      starting.current = false;
      return;
    }
    starting.current = false;
    if (wantStop.current) void finish();
  }, [busy, available, finish]);

  const release = useCallback(() => {
    if (rec.current) void finish();
    else if (starting.current) wantStop.current = true;
  }, [finish]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.code === "Space") { e.preventDefault(); if (!e.repeat) void press(); }
    };
    const up = (e: KeyboardEvent) => { if (e.code === "Space" || e.key === "Control") release(); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
    };
  }, [press, release]);

  return { available, detail, recording, busy, press, release };
}
