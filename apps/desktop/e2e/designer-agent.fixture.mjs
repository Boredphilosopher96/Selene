const mode = process.argv[2] ?? 'success';
const sentAt = '2026-07-24T00:00:00.000Z';
let sequence = 0;

const write = (kind, fields = {}) =>
  process.stdout.write(
    `${JSON.stringify({
      protocolVersion: '1.0',
      kind,
      messageId: `configured-fixture-${++sequence}`,
      sentAt,
      ...fields
    })}\n`
  );

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line) handle(JSON.parse(line));
    newline = buffer.indexOf('\n');
  }
});

function handle(message) {
  if (message.kind === 'hello') {
    write('hello', { implementation: 'configured-jsonl-fixture', capabilities: ['react.revise'] });
    return;
  }
  if (message.kind === 'cancel' && mode === 'cancel') {
    write('event', { requestId: message.requestId, event: 'cancelled' });
    return;
  }
  if (message.kind !== 'request') return;
  if (mode === 'failure') {
    write('error', {
      requestId: message.requestId,
      code: 'FIXTURE_FAILURE',
      message: 'Configured fixture failed.'
    });
    return;
  }
  if (mode === 'cancel') return;
  if (
    mode === 'context' &&
    (message.input?.generationContext?.packages?.length !== 0 ||
      message.input?.generationContext?.guidance?.length !== 1 ||
      !/^[a-f0-9]{64}$/.test(message.input.generationContext.guidance[0]?.artifactDigest ?? '') ||
      !message.input.generationContext.guidance[0]?.markdown?.startsWith('# Guidance\n\n') ||
      Buffer.byteLength(message.input.generationContext.guidance[0]?.markdown ?? '', 'utf8') <=
        64 * 1024 ||
      typeof message.input?.target?.x !== 'number' ||
      typeof message.input?.target?.y !== 'number' ||
      typeof message.input?.target?.nodeRef !== 'string' ||
      'bindingId' in (message.input?.target ?? {}) ||
      'projectId' in (message.input?.target ?? {}) ||
      'revisionId' in (message.input?.target ?? {}))
  ) {
    write('error', {
      requestId: message.requestId,
      code: 'INVALID_INPUT',
      message: 'Missing generation context.'
    });
    return;
  }
  if (
    message.operation !== 'react.revise' ||
    typeof message.input?.instruction !== 'string' ||
    (mode === 'general'
      ? message.input?.target !== undefined
      : typeof message.input?.target?.x !== 'number' ||
        typeof message.input?.target?.y !== 'number') ||
    message.input?.workspace?.format !== 'selene-react-workspace/v1' ||
    !Array.isArray(message.input?.workspace?.files) ||
    message.input.workspace.files.length === 0
  ) {
    write('error', {
      requestId: message.requestId,
      code: 'INVALID_INPUT',
      message: 'Missing targeted prompt.'
    });
    return;
  }
  write('event', {
    requestId: message.requestId,
    event: 'thinking',
    output: { detail: 'Validated prompt and normalized target.' }
  });
  write('event', {
    requestId: message.requestId,
    event: 'completed',
    output: {
      summary: 'Configured JSONL agent updated the prototype.',
      operations: [
        {
          type: 'write',
          path: 'src/App.tsx',
          content:
            mode === 'catalog'
              ? "import {useEffect,useLayoutEffect,useState} from 'react'; import './preview.css';\nexport default function App(){const [screen,setScreen]=useState('dashboard');const orders=screen==='orders';useLayoutEffect(()=>{window.history.replaceState({screen:'dashboard'},'', '/');},[]);useEffect(()=>{const onPopState=()=>setScreen(window.location.pathname==='/orders'?'orders':'dashboard');window.addEventListener('popstate',onPopState);return()=>window.removeEventListener('popstate',onPopState)},[]);const openOrders=()=>{window.history.pushState({screen:'orders'},'', '/orders');setScreen('orders')};return <main data-selene-node-id=\"designer.root\" style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 320, padding: 24, backgroundColor: '#ffffff' }}><h1 data-selene-node-id=\"designer.title\">{orders?'Orders':'Catalog-ready dashboard'}</h1><p data-selene-node-id=\"designer.summary\">Mapped flex container for governed component insertion.</p>{orders?<button data-selene-flow-node=\"orders\" data-selene-action-port=\"back\" data-selene-node-id=\"designer.back-navigation\" onClick={()=>window.history.back()}>Back to dashboard</button>:<button data-selene-flow-node=\"dashboard\" data-selene-action-port=\"open-orders\" data-selene-node-id=\"designer.action\" onClick={openOrders}>Open orders</button>}</main>}\n"
              : "import {useEffect,useLayoutEffect,useState} from 'react'; import './preview.css';\nexport default function App(){const [screen,setScreen]=useState('dashboard');const orders=screen==='orders';useLayoutEffect(()=>{window.history.replaceState({screen:'dashboard'},'', '/');},[]);useEffect(()=>{const onPopState=()=>setScreen(window.location.pathname==='/orders'?'orders':'dashboard');window.addEventListener('popstate',onPopState);return()=>window.removeEventListener('popstate',onPopState)},[]);useEffect(()=>{const captureStopper=event=>{if(event.ctrlKey)event.stopImmediatePropagation()};window.addEventListener('wheel',captureStopper,{capture:true});return()=>window.removeEventListener('wheel',captureStopper,{capture:true})},[]);const openOrders=()=>{window.history.pushState({screen:'orders'},'', '/orders');setScreen('orders')};const stopComponentWheel=event=>{if(event.ctrlKey)event.stopPropagation()};return <main data-selene-node-id=\"designer.root\" style={{ position: 'relative' }}><h1 data-selene-node-id=\"designer.title\">{orders?'Orders':'Configured agent dashboard'}</h1><p data-selene-node-id=\"designer.summary\">Configured JSONL process applied the targeted change.</p>{orders?<button data-selene-flow-node=\"orders\" data-selene-action-port=\"back\" data-selene-node-id=\"designer.back-navigation\" onWheel={stopComponentWheel} onClick={()=>window.history.back()}>Back to dashboard</button>:<button data-selene-flow-node=\"dashboard\" data-selene-action-port=\"open-orders\" data-selene-node-id=\"designer.action\" style={{ position: 'absolute', left: 24, top: 72, display: 'inline-flex', gap: 8 }} onWheel={stopComponentWheel} onClick={openOrders}>Open orders</button>}</main>}\n"
        }
      ]
    }
  });
}
