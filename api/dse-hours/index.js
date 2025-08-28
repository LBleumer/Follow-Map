const https = require('https');
const zlib = require('zlib');

module.exports = async function (context, req) {
  const respond = (status, obj) => {
    context.res = { status, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(obj, null, 2) };
  };

  const URL = process.env.DSE_CSV_URL;
  if (!URL) return respond(500, { ok:false, error:'CONFIG', msg:'DSE_CSV_URL not set' });

  const wantDebug = String(req.query.debug || '0') === '1';
  const wantDump  = String(req.query.dump  || '0') === '1';

  try {
    const head = await headOnly(URL);
    if (head.statusCode !== 200) {
      return respond(head.statusCode, { ok:false, error:'BLOB_HEAD', status: head.statusCode, headers: head.headers });
    }

    const buf = await download(URL);
    const raw = looksGzip(buf) ? zlib.gunzipSync(buf) : buf;
    let text  = raw.toString('utf-8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // strip BOM

    // Normalize EOLs
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

    // ---- Find the REAL header line (explicit, case-insensitive) ----
    const headerRegex = /^\s*Gateway Name\s*,\s*Module Name\s*,\s*Engine Hours Run\s*,\s*Timestamp\s*$/i;
    let hIndex = -1;
    for (let i = 0; i < Math.min(lines.length, 100); i++) {
      if (headerRegex.test(lines[i])) { hIndex = i; break; }
    }
    if (hIndex === -1) {
      // fall back to a softer check (contains all tokens in any spacing)
      for (let i = 0; i < Math.min(lines.length, 100); i++) {
        const L = lines[i].toLowerCase();
        if (L.includes('gateway name') && L.includes('module name') && L.includes('engine hours run') && L.includes('timestamp') && L.includes(',')) {
          hIndex = i; break;
        }
      }
    }
    if (hIndex === -1) {
      return respond(200, { ok:true, count:0, items:[], note:'HEADER_NOT_FOUND', preview: lines.slice(0, 10) });
    }

    const headers = splitCSV(lines[hIndex], ',').map(s => s.trim());
    // Expected positions (strict)
    const iGateway = headers.findIndex(h => /^gateway name$/i.test(h));
    const iModule  = headers.findIndex(h => /^module name$/i.test(h));
    const iHours   = headers.findIndex(h => /^engine hours run$/i.test(h));
    const iTs      = headers.findIndex(h => /^timestamp$/i.test(h));

    if ([iGateway,iModule,iHours,iTs].some(i => i < 0)) {
      return respond(200, { ok:true, count:0, items:[], note:'HEADER_MISMATCH', headers });
    }

    const dataLines = lines.slice(hIndex + 1).filter(l => l.trim().length > 0);

    if (wantDump) {
      return respond(200, {
        ok: true,
        headerIndex: hIndex,
        header: headers,
        first20Raw: dataLines.slice(0,20)
      });
    }

    const items = [];
    for (const line of dataLines) {
      const cols = splitCSV(line, ',');
      if (!cols || cols.length < headers.length) continue;

      const gateway = (cols[iGateway] || '').trim();
      const module  = (cols[iModule]  || '').trim();
      const hours   = (cols[iHours]   || '').trim();
      const ts      = (cols[iTs]      || '').trim();

      const moduleName = module || gateway;
      if (!moduleName) continue;

      items.push({ moduleName, hours: normalizeHours(hours), ts });
    }

    if (wantDebug) {
      return respond(200, {
        ok: true,
        headerIndex: hIndex,
        header: headers,
        firstRowsParsed: items.slice(0, 5),
        count: items.length,
        items
      });
    }

    return respond(200, { ok:true, count: items.length, items });
  } catch (e) {
    return respond(500, { ok:false, error:'FETCH_OR_PARSE', msg:String(e).slice(0,400) });
  }
};

// ----- helpers -----
function headOnly(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ method:'HEAD', hostname: u.hostname, path: u.pathname + u.search }, res => {
      resolve({ statusCode: res.statusCode, headers: res.headers }); res.resume();
    });
    req.on('error', reject); req.end();
  });
}

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode !== 200) return reject(new Error('HTTP '+res.statusCode));
      const chunks = []; res.on('data', d => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

function looksGzip(buf){ return buf && buf.length>2 && buf[0]===0x1f && buf[1]===0x8b; }

// CSV splitter that respects quotes and escaped quotes
function splitCSV(line, delim) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i+1] === '"') { cur += '"'; i++; }
      else q = !q;
    } else if (ch === delim && !q) {
      out.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// Preserve H:MM:SS; normalize 123,45 → 123.45; else pass through
function normalizeHours(s){
  if (s == null) return '';
  const t = String(s).trim();
  if (!t) return '';
  if (/^\d{1,6}:\d{1,2}:\d{1,2}$/.test(t)) return t;
  if (/^\d+,\d+$/.test(t)) return t.replace(',', '.');
  return t;
}
