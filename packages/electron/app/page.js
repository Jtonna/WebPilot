'use client';

import { useState, useEffect } from 'react';

export default function Home() {
  const [serverStatus, setServerStatus] = useState('Starting...');
  const [extensionConnected, setExtensionConnected] = useState(false);
  const [extensionInfo, setExtensionInfo] = useState({ extensionExists: false, extensionPath: '' });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.webpilot) return;

    // Check extension availability once on mount
    setExtensionInfo(window.webpilot.isExtensionAvailable());

    // Poll server health every 3 seconds
    async function checkHealth() {
      const port = window.webpilot.getServerPort();
      if (!port) {
        setServerStatus('Starting...');
        setExtensionConnected(false);
        return;
      }

      try {
        const res = await fetch(`http://localhost:${port}/health`, {
          signal: AbortSignal.timeout(3000),
        });
        const data = await res.json();
        if (data.status === 'ok') {
          setServerStatus('Running');
          setExtensionConnected(!!data.extensionConnected);
        } else {
          setServerStatus('Offline');
          setExtensionConnected(false);
        }
      } catch {
        setServerStatus('Offline');
        setExtensionConnected(false);
      }
    }

    checkHealth();
    const interval = setInterval(checkHealth, 3000);
    return () => clearInterval(interval);
  }, []);

  const statusColor =
    serverStatus === 'Running' ? '#22c55e' :
    serverStatus === 'Starting...' ? '#eab308' :
    '#ef4444';

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      backgroundColor: '#fafafa',
    }}>
      <h1 style={{ fontSize: '2.5rem', color: '#1a1a1a', marginBottom: '0.5rem' }}>
        WebPilot
      </h1>
      <p style={{ fontSize: '1.2rem', color: '#666', marginBottom: '2rem' }}>
        Onboarding goes here
      </p>
      <div style={{
        padding: '1rem 1.5rem',
        backgroundColor: '#f0f0f0',
        borderRadius: '8px',
        fontSize: '0.9rem',
        color: '#555',
        minWidth: '320px',
      }}>
        <p style={{ margin: '0.25rem 0' }}>
          MCP Server:{' '}
          <span style={{ color: statusColor, fontWeight: 600 }}>{serverStatus}</span>
        </p>
        <p style={{ margin: '0.25rem 0' }}>
          Chrome Extension:{' '}
          {extensionConnected ? (
            <span style={{ color: '#22c55e', fontWeight: 600 }}>Connected</span>
          ) : (
            <span style={{ color: '#888' }}>Not connected</span>
          )}
        </p>
        <p style={{ margin: '0.25rem 0' }}>
          Extension files:{' '}
          {extensionInfo.extensionExists ? (
            <span style={{ color: '#22c55e', fontWeight: 600 }}>Available</span>
          ) : (
            <span style={{ color: '#ef4444' }}>Not found</span>
          )}
        </p>
        {extensionInfo.extensionPath && (
          <p style={{ margin: '0.5rem 0 0.25rem', fontSize: '0.8rem', color: '#888', wordBreak: 'break-all' }}>
            Extension path: {extensionInfo.extensionPath}
          </p>
        )}
      </div>
    </div>
  );
}
