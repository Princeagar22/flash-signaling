// Quick smoke test: two fake clients join a room and exchange an offer/answer.
const WebSocket = require('ws');

const URL = 'ws://localhost:8080';
let passed = 0;
const expect = (cond, name) => {
  console.log(cond ? `PASS: ${name}` : `FAIL: ${name}`);
  if (cond) passed++;
  else process.exitCode = 1;
};

const a = new WebSocket(URL);
const b = new WebSocket(URL);

a.on('open', () => a.send(JSON.stringify({ type: 'join', room: 'TEST42' })));

a.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.type === 'joined') {
    expect(m.initiator === false, 'first peer is not initiator');
    b.send(JSON.stringify({ type: 'join', room: 'TEST42' }));
  }
  if (m.type === 'peer-joined') expect(true, 'first peer notified of second peer');
  if (m.type === 'offer') {
    expect(m.payload.sdp === 'fake-offer', 'offer relayed to first peer');
    a.send(JSON.stringify({ type: 'answer', payload: { sdp: 'fake-answer' } }));
  }
});

b.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.type === 'joined') {
    expect(m.initiator === true, 'second peer is initiator');
    b.send(JSON.stringify({ type: 'offer', payload: { sdp: 'fake-offer' } }));
  }
  if (m.type === 'answer') {
    expect(m.payload.sdp === 'fake-answer', 'answer relayed to second peer');
    a.close();
    b.close();
    setTimeout(testRandomMatch, 300);
  }
});

// Part 2: random matchmaking (OmeTV style)
function testRandomMatch() {
  const c = new WebSocket(URL);
  const d = new WebSocket(URL);

  c.on('open', () => c.send(JSON.stringify({ type: 'find' })));

  c.on('message', (data) => {
    const m = JSON.parse(data);
    if (m.type === 'waiting') {
      expect(true, 'first stranger is queued');
      d.send(JSON.stringify({ type: 'find' }));
    }
    if (m.type === 'matched') {
      expect(m.initiator === false, 'waiting stranger is not initiator');
    }
  });

  d.on('message', (data) => {
    const m = JSON.parse(data);
    if (m.type === 'matched') {
      expect(m.initiator === true, 'second stranger is initiator');
      // "Next" — d skips, c should get peer-left
      d.send(JSON.stringify({ type: 'find' }));
    }
    if (m.type === 'waiting') {
      expect(true, 'skipper re-queued after next');
    }
  });

  let cGotPeerLeft = false;
  c.on('message', (data) => {
    const m = JSON.parse(data);
    if (m.type === 'peer-left' && !cGotPeerLeft) {
      cGotPeerLeft = true;
      expect(true, 'partner notified when skipped');
      c.close();
      d.close();
      setTimeout(() => {
        expect(passed === 10, `all 10 checks passed (${passed}/10)`);
        process.exit(process.exitCode || 0);
      }, 300);
    }
  });
}

setTimeout(() => {
  console.log('FAIL: test timed out');
  process.exit(1);
}, 5000);
