import { useEffect, useRef, useState } from 'react';

import type { ReactSourceWorkspace } from '@selene/core';

import { App as DesignerApp } from '../../../../web/src/app';

const generatedPreview: ReactSourceWorkspace = {
  format: 'selene-react-workspace/v1',
  projectId: 'desktop-preview',
  entrypoint: 'src/App.tsx',
  files: [
    {
      path: 'src/App.tsx',
      language: 'tsx',
      content:
        'import \'./preview.css\';\nimport { title } from \'./content\';\nexport default function App(){return <main data-selene-node-id="preview.root"><h1 data-selene-node-id="preview.title">{title}</h1><button data-selene-node-id="preview.action">Create order</button></main>}\n'
    },
    {
      path: 'src/content.ts',
      language: 'ts',
      content: "export const title = 'Generated Orders';\n"
    },
    {
      path: 'src/preview.css',
      language: 'css',
      content: 'main { padding: 24px; font-family: system-ui; } button { padding: 8px; }\n'
    }
  ],
  dependencies: ['react', 'react-dom', 'react-dom/client'],
  nodes: [
    { nodeId: 'preview.root', path: 'src/App.tsx', exportName: 'default' },
    { nodeId: 'preview.title', path: 'src/App.tsx', exportName: 'default' },
    { nodeId: 'preview.action', path: 'src/App.tsx', exportName: 'default' }
  ],
  revision: {
    id: 'desktop-preview-r1',
    createdAt: '2026-07-23T22:23:00Z',
    summary: 'Fake agent generated an orders screen'
  }
};

type BuildResult = Awaited<ReturnType<Window['selene']['preview']['build']>>;

function isFrameMessage(
  value: unknown,
  build: BuildResult
): value is {
  type: 'ready' | 'select-node' | 'rendered' | 'runtime-error';
  nonce: string;
  origin: string;
  revisionId: string;
  nodeId?: string;
  message?: string;
} {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    (message.type === 'ready' ||
      message.type === 'select-node' ||
      message.type === 'rendered' ||
      message.type === 'runtime-error') &&
    message.nonce === build.policy.nonce &&
    message.origin === build.policy.origin &&
    message.revisionId === build.revisionId
  );
}

function GeneratedPreview() {
  const frame = useRef<HTMLIFrameElement>(null);
  const [build, setBuild] = useState<BuildResult>();
  const [selectedNode, setSelectedNode] = useState('No generated node selected');
  const [notice, setNotice] = useState('Generated source has not been rendered.');

  useEffect(() => {
    if (build === undefined) return;
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== frame.current?.contentWindow || !isFrameMessage(event.data, build))
        return;
      window.selene.preview.postMessage(build.policy, event.data);
      if (event.data.type === 'select-node' && event.data.nodeId !== undefined)
        setSelectedNode(event.data.nodeId);
      if (event.data.type === 'runtime-error')
        setNotice(`Preview error: ${event.data.message ?? 'unknown error'}`);
      if (event.data.type === 'ready')
        setNotice('Generated React preview rendered in a sandboxed frame.');
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [build]);

  async function renderGeneratedPreview() {
    try {
      const next = await window.selene.preview.build(generatedPreview);
      setBuild(next);
      setNotice('Compiling the typed fake-agent workspace…');
    } catch (error) {
      setNotice(
        error instanceof Error ? `Preview error: ${error.message}` : 'Preview error: build failed.'
      );
    }
  }

  return (
    <section aria-label="Generated React preview" style={{ margin: '16px auto', maxWidth: 1100 }}>
      <button type="button" onClick={() => void renderGeneratedPreview()}>
        Render generated React preview
      </button>
      <p>{notice}</p>
      <p aria-live="polite">Selected generated node: {selectedNode}</p>
      {build === undefined ? null : (
        <iframe
          ref={frame}
          title="Generated React preview frame"
          src={build.url}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          style={{ border: '1px solid #ccd', height: 180, width: '100%' }}
        />
      )}
    </section>
  );
}

/** Desktop adds a narrow, typed preview bridge around the portable web workspace. */
export function App() {
  return (
    <>
      <DesignerApp />
      <GeneratedPreview />
    </>
  );
}
