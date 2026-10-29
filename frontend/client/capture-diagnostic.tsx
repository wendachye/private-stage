'use client';

import { useRef, useState } from 'react';
import { createLocalScreenTracks } from 'livekit-client';

export default function CaptureDiagnostic() {
  const [result, setResult] = useState('Ready. This check never publishes or records your screen.');
  const current = useRef(0);
  function run(audio: boolean, raw: boolean) {
    const attempt = ++current.current;
    setResult(`Pending: ${raw ? 'browser' : 'LiveKit'} capture; audio=${audio}`);
    const request = raw
      ? navigator.mediaDevices.getDisplayMedia({ audio, video: true }).then(stream => stream.getTracks())
      : createLocalScreenTracks({ audio, resolution: { width: 1280, height: 720, frameRate: 15 } });
    void request.then(tracks => {
      const counts = { video: tracks.filter(t => t.kind === 'video').length, audio: tracks.filter(t => t.kind === 'audio').length };
      tracks.forEach(track => track.stop());
      if (attempt === current.current) setResult(JSON.stringify({ state: 'captured-and-stopped', mode: raw ? 'browser' : 'LiveKit', requestedAudio: audio, ...counts }));
    }, error => {
      if (attempt === current.current) setResult(JSON.stringify({ state: 'failed', mode: raw ? 'browser' : 'LiveKit', requestedAudio: audio, error: error instanceof Error ? error.name : 'UnknownError' }));
    });
  }
  return <main style={{ maxWidth: 850, margin: '60px auto', padding: 24, color: '#eee', fontFamily: 'system-ui' }}>
    <h1>Screen capture diagnostic</h1>
    <p>Development only. Choose a safe window or tab. Tracks stop immediately after capture; no media is published or recorded.</p>
    <p>Each button requests capture directly from its click. Use the browser chooser yourself.</p>
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
      <button onClick={() => run(false, false)}>LiveKit without audio</button>
      <button onClick={() => run(true, false)}>LiveKit with audio</button>
      <button onClick={() => run(true, true)}>Browser with audio</button>
      <button onClick={() => { ++current.current; setResult('Cancelled locally. Any late tracks will be stopped.'); }}>Cancel diagnostic</button>
    </div>
    <pre role="status" style={{ whiteSpace: 'pre-wrap', marginTop: 32 }}>{result}</pre>
  </main>;
}
