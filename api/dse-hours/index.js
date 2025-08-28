const https = require('https');
const zlib = require('zlib');

module.exports = async function (context, req) {
  const respond = (status, obj) => {
    context.res = { status, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(obj, null, 2) };
  };

  const URL = process.env.DSE_CSV_URL;
  if (!URL) return respond(500, { ok:false, error:'CONFIG', msg:'DSE_CSV_URL not set in environment variables' });

  try {
    // quick HEAD for clearer errors
    const head = await headOnly(URL);
    if (head.statusCode >= 400) {
      return respond(head.statusCode, {
        ok:false, error:'BLOB_HEAD', status: head.statusCode,
        hint: 'Regenerate SAS with READ permission and a future expiry (se=...).',
        headers: head.headers
      });
    }

    const buf = await download(URL);
    const raw = looksGzip(buf) ? zlib.gunzipSync(buf) : buf;
    const text = raw.toString('utf-8');

    const items = parseDSECSV(text);
    return respond(200, { ok:true, count: items.length, items });
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

// very tolerant CSV → [{moduleName,hours,ts}]
function parseDSECSV(text){
  const lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n').filter(Boolean);
  if (!lines.length) return [];
  const header = lines[0];
  const delim = (header.match(/;/g)||[]).length >= (header.match(/,/g)||[]).length ? ';' : ',';
  const headers = header.split(delim).map(h => h.trim().toLowerCase());

  const find = (alts)=> headers.findIndex(h => alts.some(a => h.includes(a)));
  const iName  = find(['name','module','modulenaam','unit','machine','generator']);
  const iHours = find(['hour','draai','enginehour','runninghour','bedrijfstijd']);
  const iTs    = find(['time','datum','date','timestamp','ts','laatst']);

  const out = [];
  for (let i=1;i<lines.length;i++){
    const cols = split(lines[i], delim);
    if (cols.length===1 && cols[0].trim()==='') continue;
    out.push({
      moduleName: iName>=0 ? cols[iName].trim() : '',
      hours:      iHours>=0 ? cols[iHours].trim() : '',
      ts:         iTs>=0 ? cols[iTs].trim() : ''
    });
  }
  return out.filter(r => r.moduleName);
}

function split(line, delim){
  const res=[]; let cur=''; let q=false;
  for (let i=0;i<line.length;i++){
    const ch=line[i];
    if (ch === '"'){ if (q && line[i+1]==='"'){ cur+='"'; i++; } else q=!q; }
    else if (ch===delim && !q){ res.push(cur); cur=''; }
    else cur+=ch;
  }
  res.push(cur); return res;
}
