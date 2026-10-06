import React, { useState } from 'react';
import App from './App';
import { FiberPlanning } from './components/FiberPlanning';
import { LaneClosureTCPStudio } from './components/LaneClosureTCPStudio';

/**
 * Top-level entry point choosing between the genuinely separate tools:
 * the existing intersection-focused TCP Plan project (App.tsx, unchanged),
 * the Fiber Planning tool (FiberPlanning.tsx), and the new straight-road
 * Lane Closure TCP studio (LaneClosureTCPStudio.tsx, ported from the
 * user's own "Marina TCP Studio" HTML prototype) — none of the three
 * imports or depends on either other's state.
 *
 * This file exists because I don't have visibility into this project's
 * actual main.tsx/entry point (it wasn't part of what's been shared with
 * me), so I can't directly wire routing into it. What you'll need to do:
 * wherever your entry point currently does `ReactDOM.createRoot(...).
 * render(<App />)`, render <AppSelector /> instead. If this project
 * already uses react-router (or you'd rather it did), this simple
 * useState toggle can be swapped for three actual routes — the tool
 * components underneath don't care either way, since they don't share
 * state with this selector or each other.
 */
export default function AppSelector() {
  const [tool, setTool] = useState<'tcp' | 'fiber' | 'laneclosure'>('tcp');

  return (
    <div style={{ height: '100vh', width: '100vw', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', gap: 4, padding: '6px 10px', background: '#09090b', borderBottom: '1px solid #27272a', flexShrink: 0 }}>
        <button
          onClick={() => setTool('tcp')}
          style={{
            padding: '5px 14px', fontSize: 12, fontWeight: 700, borderRadius: 6, cursor: 'pointer', border: 'none',
            background: tool === 'tcp' ? '#f97316' : 'transparent',
            color: tool === 'tcp' ? '#111' : '#a1a1aa',
          }}
        >
          TCP Plan
        </button>
        <button
          onClick={() => setTool('fiber')}
          style={{
            padding: '5px 14px', fontSize: 12, fontWeight: 700, borderRadius: 6, cursor: 'pointer', border: 'none',
            background: tool === 'fiber' ? '#f97316' : 'transparent',
            color: tool === 'fiber' ? '#111' : '#a1a1aa',
          }}
        >
          Fiber Planning
        </button>
        <button
          onClick={() => setTool('laneclosure')}
          style={{
            padding: '5px 14px', fontSize: 12, fontWeight: 700, borderRadius: 6, cursor: 'pointer', border: 'none',
            background: tool === 'laneclosure' ? '#f97316' : 'transparent',
            color: tool === 'laneclosure' ? '#111' : '#a1a1aa',
          }}
        >
          Lane Closure TCP
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {tool === 'tcp' ? <App /> : tool === 'fiber' ? <FiberPlanning /> : <LaneClosureTCPStudio />}
      </div>
    </div>
  );
}
