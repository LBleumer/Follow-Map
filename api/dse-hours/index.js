const https = require('https');
const zlib = require('zlib');

module.exports = async function (context, req) {
  const respond = (status, obj) => {
    context.res = { status, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(obj, null, 2) };
  };

  const URL = process.env.DSE_CSV_URL;
  if (!URL) return respond(500, { ok:false, error:'CONFIG', msg:'DSE_CSV_URL not set' });

  // Optional debug
  const wantDebug = String(req.query.debug || '0') === '1';

  try {
    const head = await headOnly(URL);
    const meta = { status: head.statusCode, 'content-type': head.headers['content-type'], 'content-length': head.headers['content-length'], 'last-modified': head.headers['last-modified'] };

    if (head.statusCode >= 400) {
      return respond(head.statusCode, { ok:false, error:'BLOB_HEAD', meta, hint:'Regenerate SAS with READ permission and non-expired se=...' });
    }

    const buf = await download(URL);
    const raw = looksGzip(buf) ? zlib.gunzipSync(buf) : buf;
    let text = raw.toString('utf-8');

    // Strip UTF-8 BOM if present
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

    const parsed = parseDSECSV(text, wantDebug);

    if (wantDebug) {
      return respond(200, {
        ok: true,
        meta,
        debug: {
          firstBytes: text.slice(0, 500),
          delimiter: parsed._debug.delim,
          header: parsed._debug.headers,
          nameIndex: parsed._debug.iName,
          hoursIndex: parsed._debug.iHours,
          tsIndex: parsed._debug.iTs,
          firstRowsParsed: parsed.items.slice(0, 5)
        },
        count: parsed.items.length,
        items: parsed.items
      });
    }

    return respond(200, { ok:true, count: parsed.items.length, items: parsed.items });
  } catch (e) {
    return respond(500, { ok:false, error:'FETCH_OR_PARSE', msg: String(e).slice(0,400) });
  }
};

function headOnly(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ method:'HEAD', hostname:u.hostname, path:u.pathname + u.search }, res => {
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

function parseDSECSV(text, debug=false){
  // normalize EOLs, keep empty lines out
  const lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n').filter(l => l.length>0);
  if (!lines.length) return { items: [], _debug: { delim: ',', headers: [], iName:-1,iHours:-1,iTs:-1 } };

  const header = lines[0];

  // Heuristic delimiter detection (favor ; for Dutch Excel)
  const counts = { ';': (header.match(/;/g)||[]).length, ',': (header.match(/,/g)||[]).length, '\t': (header.match(/\t/g)||[]).length };
  let delim = ';';
  if (counts['\t'] > counts[';'] && counts['\t'] > counts[',']) delim = '\t';
  else if (counts[','] > counts[';']) delim = ',';

  const headers = split(header, delim).map(h => h.trim());

  // Find indices (lots of variants)
  const find = (alts) => headers.findIndex(h => {
    const L = h.toLowerCase();
    return alts.some(a => L.includes(a));
  });

  const iName  = find(['name','module','modulenaam','unit','machine','generator','device']);
  const iHours = find(['hour','draai','enginehour','runninghour','bedrijfstijd','uren','runtime','run time']);
  const iTs    = find(['time','datum','date','timestamp','ts','laatst','last']);

  const items = [];
  for (let i=1;i<lines.length;i++){
    const cols = split(lines[i], delim);
    // skip pure header repeats or separators
    if (cols.length <= 1 || cols.every(c => c.trim()==='')) continue;

    const moduleName = iName>=0 ? cols[iName].trim() : '';
    const hoursRaw   = iHours>=0 ? cols[iHours].trim() : '';
    const tsRaw      = iTs>=0 ? cols[iTs].trim() : '';

    if (!moduleName) continue; // must have a name to show in the table

    items.push({
      moduleName,
      hours: normalizeHours(hoursRaw),
      ts: tsRaw
    });
  }

  return { items, _debug: debug ? { delim, headers, iName, iHours, iTs } : undefined };
}

// CSV split that respects quotes and embedded delimiters
function split(line, delim){
  const out=[]; let cur=''; let q=false;
  for (let i=0;i<line.length;i++){
    const ch=line[i];
    if (ch === '"'){
      if (q && line[i+1] === '"'){ cur += '"'; i++; } else { q = !q; }
    } else if (ch === delim && !q){
      out.push(cur); cur='';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// Accept H:MM:SS or decimals (comma/point) and pass through as display string
function normalizeHours(s){
  if (s == null) return '';
  const t = String(s).trim();
  if (!t) return '';
  if (/^\d{1,6}:\d{1,2}:\d{1,2}$/.test(t)) return t;      // 3895:41:13
  if (/^\d+,\d+$/.test(t)) return t.replace(',', '.');    // 123,45 -> 123.45
  return t;                                               // leave as-is otherwise
}
