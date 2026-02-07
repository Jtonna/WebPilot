'use client';

import { useState, useEffect } from 'react';

export default function Home() {
  const [status, setStatus] = useState({ extensionExists: false, deploymentPath: '' });

  useEffect(() => {
    if (typeof window !== 'undefined' && window.webpilot) {
      setStatus(window.webpilot.isDeployed());
    }
  }, []);

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
        color: '#888',
      }}>
        <p style={{ margin: '0.25rem 0' }}>
          Extension deployed: {status.extensionExists ? 'Yes' : 'No'}
        </p>
        {status.deploymentPath && (
          <p style={{ margin: '0.25rem 0', fontSize: '0.8rem' }}>
            Path: {status.deploymentPath}
          </p>
        )}
        <p style={{ margin: '0.25rem 0' }}>
          MCP Server: Not connected
        </p>
      </div>
    </div>
  );
}
