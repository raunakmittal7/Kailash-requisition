// Stand-in for the Anthropic Messages API, for testing api/read.js only.
// Answers every request with a fixed reading of a handwritten slip, and records what it was sent.
const http = require('http');
const PORT = +process.argv[2] || 8790;
http.createServer((req, res) => {
  const b = [];
  req.on('data', d => b.push(d));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(b).toString() || '{}');
    const imgs = (body.messages?.[0]?.content || []).filter(c => c.type === 'image').length;
    console.log('anthropic call', req.url, 'model', body.model, 'images', imgs, 'auth', Object.keys(req.headers).filter(k=>/key|auth|beta|version/.test(k)).map(k=>k+'='+String(req.headers[k]).slice(0,40)).join(' '));
    const reading = {
      needed_by: '', notes: '',
      items: [
        { slip_text: 'PVC pipe 1in 20 nos', list_name: null, name: 'PVC pipe 1 inch', qty: 20, unit: 'pcs', sub_unit: '', category: '', brand: 'Supreme', spec: '1 inch', area: '', sure: true },
        { slip_text: 'cemnt 50 bag?', list_name: null, name: 'Cement', qty: 50, unit: 'bags', sub_unit: '', category: '', brand: '', spec: '', area: '', sure: false },
      ],
    };
    const text = (body.messages?.[0]?.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    let answer = reading;
    if (/sonnet/.test(body.model)) answer = { ...reading, items: reading.items.map(i => ({ ...i, sure: true })) }; // the stronger model reads clearly
    if (text.includes('TYPED items')) { // item name check: every typed item is the existing "PPC cement"
      const rows = JSON.parse(text.split('TYPED items (JSON):\n')[1].split('\n')[0]);
      answer = { items: rows.map(r => ({ i: r.i, name: 'PPC cement', existing: 'PPC cement', why: 'spelling' })) };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_test', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: 'Here is the JSON:\n' + JSON.stringify(answer) }],
      usage: { input_tokens: 10, output_tokens: 10 },
    }));
  });
}).listen(PORT, () => console.log('fake anthropic on', PORT));
