const { BlobServiceClient, ContainerClient } = require('@azure/storage-blob');
const zlib = require('zlib');

module.exports = async function (context, req) {
  const respond = (status, obj) => {
    context.res = {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(obj, null, 2)
    };
  };

  const https = require('https');
const zlib = require('zlib');

module.exports = async function (context, req) {
  const respond = (status, obj) => {
    context.res = {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(obj, null, 2)
    };
  };

  const url = process.env.DSE_CSV_URL;
  if (!url) {
    return respond(500, { ok:false, error:'CONFIG', msg:'DSE_CSV_URL not set in environment variables' });
  }

  try {
    const buf = await download(url);
    const raw = looksGzip(buf) ? zlib.gunzipSync(buf) : buf;
    const csvText = raw.toString('utf-8');
    const items = parseDSECSV(csvText);

    return respond(200, { ok:true, count: items.length, items });
  } catch (e) {
    return respond(500, { ok:false, error:'FETCH', msg:String(e) });
  }
};

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode !== 200) return reject(new Error('HTTP '+res.statusCode));
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

function looksGzip(buf) {
  return buf && buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

// Simple CSV parser (semicolon or comma)
function parseDSECSV(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter(Boolean);
  if (!lines.length) return [];

  const delim = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ';' : ',';
  const headers = lines[0].split(delim).map(h => h.trim().toLowerCase());

  const iName  = headers.findIndex(h => h.includes('name') || h.includes('module'));
  const iHours = headers.findIndex(h => h.includes('hour') || h.includes('draai'));
  const iTs    = headers.findIndex(h => h.includes('time') || h.includes('datum'));

  return lines.slice(1).map(line => {
    const cols = line.split(delim);
    return {
      moduleName: iName >= 0 ? cols[iName] : '',
      hours:      iHours >= 0 ? cols[iHours] : '',
      ts:         iTs >= 0 ? cols[iTs] : ''
    };
  }).filter(r => r.moduleName);
}

  // ---- Config via environment variables ----
  // Option A (recommended): SAS URL that points to a *container*
  //   BLOB_SAS_URL = https://<acct>.blob.core.windows.net/<container>?<SAS>
  //
  // Option B: full connection string + container name
  //   AZURE_STORAGE_CONNECTION_STRING = DefaultEndpointsProtocol=... ; AccountKey=...
  //   DSE_CONTAINER = <container-name>
  //
  // Optional: limit file selection to a prefix (folder-like)
  //   DSE_BLOB_PREFIX = reports/  (or leave empty)
  //
  const SAS_URL   = process.env.BLOB_SAS_URL || '';
  const CONN_STR  = process.env.AZURE_STORAGE_CONNECTION_STRING || '';
  const CONT_NAME = process.env.DSE_CONTAINER || '';
  const PREFIX    = process.env.DSE_BLOB_PREFIX || '';

  let container;
  try {
    if (SAS_URL) {
      // SAS points to a container URL
      container = new ContainerClient(SAS_URL);
    } else if (CONN_STR && CONT_NAME) {
      const svc = BlobServiceClient.fromConnectionString(CONN_STR);
      container = svc.getContainerClient(CONT_NAME);
    } else {
      return respond(500, {
        ok: false,
        error: 'CONFIG',
        msg: 'Set BLOB_SAS_URL (container SAS) OR AZURE_STORAGE_CONNECTION_STRING + DSE_CONTAINER.'
      });
    }
  } catch (e) {
    return respond(500, { ok:false, error:'BLOB_INIT', msg: String(e) });
  }

  // ---- pick the newest CSV file (optionally by prefix) ----
  let newest = null;
  try {
    for await (const blob of container.listBlobsFlat({ prefix: PREFIX || undefined })) {
      if (!/\.csv(\.gz)?$/i.test(blob.name)) continue;
      if (!newest || blob.properties.lastModified > newest.properties.lastModified) {
        newest = blob;
      }
    }
  } catch (e) {
    return respond(500, { ok:false, error:'LIST_BLOBS', msg: String(e) });
  }

  if (!newest) {
    return respond(200, { ok:true, count:0, items:[], note:'No CSV found in container (check prefix and Logic App output).' });
  }

  // ---- download the CSV ----
  let csvText = '';
  try {
    const blobClient = container.getBlobClient(newest.name);
    const dl = await blobClient.download();
    const buf = await streamToBuffer(dl.readableStreamBody);
    // handle optional gzip
    const raw = looksGzip(buf) ? zlib.gunzipSync(buf) : buf;
    csvText = raw.toString('utf-8');
  } catch (e) {
    const msg = String(e || '');
    const isAuth = /AuthenticationFailed|Authorization|403/.test(msg);
    return respond(isAuth ? 403 : 500, {
      ok:false,
      error: isAuth ? 'AUTH' : 'DOWNLOAD',
      msg: isAuth
        ? 'Authentication failed reading Blob. Check BLOB_SAS_URL or storage connection string + keys.'
        : msg,
      hint: 'If the container is Private, the function must use a valid SAS or account key.'
    });
  }

  // ---- parse CSV (robust) ----
  let items = [];
  try {
    items = parseDSECSV(csvText);
  } catch (e) {
    return respond(502, { ok:false, error:'CSV_PARSE', msg:String(e).slice(0,400) });
  }

  return respond(200, {
    ok: true,
    source_blob: newest.name,
    lastModifiedUtc: newest.properties.lastModified,
    count: items.length,
    items
  });
};

// ============ helpers ============

function looksGzip(buf) {
  return buf && buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

function streamToBuffer(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on('data', (d) => chunks.push(Buffer.from(d)));
    readable.on('end',  () => resolve(Buffer.concat(chunks)));
    readable.on('error', reject);
  });
}

// Basic CSV parser that auto-detects delimiter (; or ,)
// and maps common DSE columns → { moduleName, hours, ts }
function parseDSECSV(text) {
  // Normalize line endings
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(Boolean);
  if (!lines.length) return [];

  // Detect delimiter from header
  const headerLine = lines[0];
  const semi = (headerLine.match(/;/g) || []).length;
  const comma = (headerLine.match(/,/g) || []).length;
  const delim = semi >= comma ? ';' : ',';

  const headers = splitCSVLine(headerLine, delim).map(h => norm(h));

  // Find column indexes
  const idx = (want) => {
    const i = headers.findIndex(h => want.some(w => h.includes(w)));
    return i >= 0 ? i : -1;
  };

  // common guesses for columns
  const iName = idx(['name','module','modulenaam','unit','machine','generator']);
  const iHours = idx(['hours','draaiuren','enginehours','runninghours','turnover','bedrijfstijd']);
  const iTs = idx(['timestamp','date','datum','ts','time','laatst']);

  const out = [];
  for (let li = 1; li < lines.length; li++) {
    const cols = splitCSVLine(lines[li], delim);
    if (cols.length === 1 && cols[0] === '') continue; // skip empty
    const moduleName = iName >= 0 ? cols[iName] : '';
    const hoursRaw   = iHours >= 0 ? cols[iHours] : '';
    const tsRaw      = iTs >= 0 ? cols[iTs] : '';

    // keep both raw and normalized hours string
    const hours = normalizeHours(hoursRaw);

    out.push({
      moduleName: (moduleName || '').trim(),
      hours: hours ?? (hoursRaw || '').trim(),
      ts: (tsRaw || '').trim()
    });
  }
  return out;
}

// Split respecting quoted fields ("a;b", etc)
function splitCSVLine(line, delim) {
  const res = [];
  let cur = '';
  let q = false;
  for (let i=0; i<line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i+1] === '"') { cur += '"'; i++; }
      else q = !q;
    } else if (ch === delim && !q) {
      res.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  res.push(cur);
  return res;
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w]+/g, '');
}

// Accept both "3895:41:13" and "3895.68" etc; leave as original string if needed
function normalizeHours(h) {
  if (h == null) return null;
  const s = String(h).trim();
  if (!s) return null;

  // If already looks like HHHH:MM:SS, just return it
  if (/^\d{1,6}:\d{1,2}:\d{1,2}$/.test(s)) return s;

  // If decimal with comma → replace comma
  if (/^\d+,\d+$/.test(s)) return s.replace(',', '.');

  // If plain integer/float → keep as is
  if (/^\d+(\.\d+)?$/.test(s)) return s;

  // Otherwise return original (don’t throw)
  return s;
}
