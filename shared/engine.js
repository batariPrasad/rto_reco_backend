// Pure reconciliation engine shared by the server and the React client (no DOM, no Node APIs).
export function normAwb(s){ return String(s == null ? '' : s).toUpperCase().replace(/[^0-9A-Z]/g, ''); }

// Pull AWB-like tokens out of pasted text / sheet cells. Ignores headers like "DELHIVERY-KWIKSHIP".
export function parseScanTokens(values){
  const out = [];
  for (const v of values){
    if (v == null) continue;
    const str = (typeof v === 'number' && Number.isFinite(v)) ? (Number.isInteger(v) ? v.toFixed(0) : String(v)) : String(v);
    for (const part of str.split(/[\s,;|\t]+/)){
      const t = normAwb(part);
      if (t.length >= 8 && /\d{6,}/.test(t)) out.push(t);
    }
  }
  return out;
}

export function summarizeScans(tokens){
  const counts = new Map();
  tokens.forEach(t => counts.set(t, (counts.get(t) || 0) + 1));
  const unique = [...counts.keys()];
  const dups = unique.filter(t => counts.get(t) > 1);
  return { unique, dups, total: tokens.length };
}

export function hamming(a, b){ let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d; }

// True when two reads are the same shipment: identical, or one is the other with a few extra
// characters at the start/end (e.g. typed "SF4118903092" vs scanned "SF4118903092GOM"), or a 16+ digit AWB
// whose last digit Excel turned into 0. Two different AWBs never pass (the shorter must keep 10+ chars, 8+ digits).
export function sameShipment(a, b){
  if (!a || !b) return false;
  if (a === b) return true;
  if (/^\d{16,}$/.test(a) && a.length === b.length && /^\d+$/.test(b) && a.slice(0, 15) === b.slice(0, 15) &&
      (/^0+$/.test(a.slice(15)) || /^0+$/.test(b.slice(15)))) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (s.length < 10 || l.length - s.length > 5 || (s.match(/\d/g) || []).length < 8) return false;
  return l.startsWith(s) || l.endsWith(s);
}

// Collapse a list of AWBs to one per shipment (keeps the first seen; the longer read wins as the label).
export function dedupeShipments(list){
  const out = [], merged = [];
  for (const a of list){
    const i = out.findIndex(x => sameShipment(x, a));
    if (i < 0){ out.push(a); continue; }
    merged.push({ awb: a, of: out[i] });
    if (a.length > out[i].length) out[i] = a;
  }
  return { unique: out, merged };
}

// pod: [{page, section, serial, awb, partial, mark}]  mark: "X" | "D" | ""
// scans: array of unique normalized AWBs
export function reconcile(pod, scans){
  const unmatched = new Set(scans);
  const rows = pod.map((r, i) => ({ ...r, idx: i, awb: normAwb(r.awb), matchedScan: '', how: '', candidates: [] }));
  const take = (r, s, how) => { r.matchedScan = s; r.how = how; unmatched.delete(s); };

  // The same AWB listed twice on the POD (a page photographed twice, overlapping photos) is one package:
  // later copies are set aside so they are not reported as "not scanned".
  const firstOnPod = new Map();
  rows.forEach(r => {
    if (r.partial || !r.awb) return;
    if (firstOnPod.has(r.awb)){ r.how = 'pod_dup'; r.dupOf = firstOnPod.get(r.awb); } else firstOnPod.set(r.awb, r);
  });

  // Pass 1: exact full AWB
  rows.forEach(r => { if (!r.partial && r.awb && unmatched.has(r.awb)) take(r, r.awb, 'exact'); });
  // Pass 1b: Excel keeps only 15 digits of a number, so 16-digit AWBs saved as numbers end in 0 (…944314 -> …944310)
  rows.forEach(r => {
    if (r.how || r.partial || !/^\d{16,}$/.test(r.awb)) return;
    const c = [...unmatched].filter(s => s.length === r.awb.length && s.slice(0, 15) === r.awb.slice(0, 15) && /^0+$/.test(s.slice(15)));
    if (c.length === 1) take(r, c[0], 'excel');
  });
  // Pass 2: cropped AWB -> unique exact suffix
  rows.forEach(r => {
    if (r.how || !r.partial || r.awb.length < 4) return;
    const c = [...unmatched].filter(s => s.endsWith(r.awb));
    if (c.length === 1) take(r, c[0], 'cropped'); else if (c.length > 1) r.candidates = c;
  });
  // Pass 3: full AWB, one digit different (OCR or typo)
  rows.forEach(r => {
    if (r.how || r.partial || !r.awb) return;
    const c = [...unmatched].filter(s => s.length === r.awb.length && hamming(s, r.awb) <= 1);
    if (c.length === 1) take(r, c[0], 'fuzzy'); else if (c.length > 1) r.candidates = c;
  });
  // Pass 4: cropped AWB, one digit different in the visible part
  rows.forEach(r => {
    if (r.how || !r.partial || r.awb.length < 4) return;
    const c = [...unmatched].filter(s => s.length >= r.awb.length && hamming(s.slice(-r.awb.length), r.awb) <= 1);
    if (c.length === 1) take(r, c[0], 'fuzzy'); else if (c.length > 1 && !r.candidates.length) r.candidates = c;
  });

  rows.forEach(r => {
    const x = r.mark === 'X', d = r.mark === 'D';
    if (r.how === 'pod_dup'){
      r.status = 'pod_duplicate';
    } else if (r.how === 'exact' || r.how === 'cropped' || r.how === 'excel'){
      r.status = x ? 'conflict' : (d ? 'damaged' : 'matched');
    } else if (r.how === 'fuzzy'){
      r.status = 'verify';
    } else {
      r.status = x ? 'not_received_marked' : 'pod_not_scanned';
    }
    r.note = ({
      matched: r.how === 'cropped' ? 'Matched on visible digits (AWB cropped in photo)'
             : r.how === 'excel' ? 'Matched. Excel changed the last digit of the scan to 0 (' + r.matchedScan + '). Format the scan column as Text' : '',
      conflict: 'Marked ✗ Not received on POD, but it WAS scanned. Check which is right',
      damaged: 'Received, marked D (damaged/tampered). Photograph and raise a claim',
      verify: 'One digit differs from scan ' + r.matchedScan + '. Check the paper POD',
      not_received_marked: 'Not scanned and already marked ✗ on POD. Consistent',
      pod_not_scanned: 'On POD but not scanned. Mark ✗ before signing / raise a claim',
      pod_duplicate: 'Same AWB already listed on the POD (page ' + (r.dupOf && r.dupOf.page || '?') + ', #' + (r.dupOf && r.dupOf.serial || '?') + '). Counted once'
    })[r.status] + (r.candidates.length ? ' (possible: ' + r.candidates.join(', ') + ')' : '');
  });

  const extras = [...unmatched].map(s => ({ awb: s, status: 'scan_not_on_pod',
    note: 'Scanned but not on this POD. Ask transporter for POD, or check if it is another courier/barcode' }));
  return { rows, extras };
}

// Checks the extraction against the POD's own printed counts and serial numbers.
export function validatePod(pod, sections){
  const msgs = [];
  const groups = new Map();
  const keyOf = r => r.sectionKey || (r.page + '||' + r.section);
  pod.forEach(r => { const k = keyOf(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
  for (const [k, list] of groups){
    const meta = sections.find(s => s.key === k);
    const declared = meta && Number.isFinite(meta.declared) ? meta.declared : null;
    const label = 'Section "' + (list[0].section || 'unnamed') + '"';
    if (declared != null && declared !== list.length)
      msgs.push({ lvl: 'bad', text: label + ': POD says ' + declared + ' pkgs but ' + list.length + ' rows were read. Rows may be missing.' });
    const serials = new Set(list.map(r => Number(r.serial)).filter(Number.isFinite));
    const max = Math.max(declared || 0, ...serials);
    const missing = []; for (let i = 1; i <= max; i++) if (!serials.has(i)) missing.push(i);
    if (missing.length) msgs.push({ lvl: 'bad', text: label + ': serial numbers missing: ' + missing.join(', ') });
    const lens = list.filter(r => !r.partial).map(r => normAwb(r.awb).length);
    if (lens.length){
      const freq = {}; lens.forEach(l => freq[l] = (freq[l] || 0) + 1);
      const common = +Object.keys(freq).sort((a, b) => freq[b] - freq[a])[0];
      list.filter(r => !r.partial && normAwb(r.awb).length !== common)
          .forEach(r => msgs.push({ lvl: 'warn', text: label + ' #' + r.serial + ': ' + r.awb + ' has ' + normAwb(r.awb).length + ' characters (others have ' + common + ')' }));
    }
    const cropped = list.filter(r => r.partial).length;
    if (cropped) msgs.push({ lvl: 'warn', text: label + ': ' + cropped + ' AWB(s) cropped in the photo. They will be matched on visible digits.' });
  }
  const seen = new Map();
  pod.filter(r => !r.partial).forEach(r => { const a = normAwb(r.awb); seen.set(a, (seen.get(a) || 0) + 1); });
  [...seen].filter(([, n]) => n > 1).forEach(([a]) => msgs.push({ lvl: 'warn', text: 'AWB ' + a + ' appears more than once on the POD' }));
  if (!msgs.length && pod.length) msgs.push({ lvl: 'ok', text: 'All sections check out: counts and serial numbers match what the POD declares.' });
  return msgs;
}
// Is this POD section ours? Checks company name first, then the return address.
export function matchOurSection(sec, compName, compAddr){
  const n = t => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const hay = n([sec.company, sec.service, sec.header].join(' '));
  const name = n(compName);
  if (name && hay.includes(name)) return 'name';
  const STOP = ['floor', 'road', 'near', 'school', 'cross', 'main', 'stage', 'phase', 'layout', 'nagar', 'street', 'bangalore', 'bengaluru', 'karnataka', 'india', 'pincode', 'district', 'urban', 'rural'];
  const words = [...new Set(String(compAddr || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => /[a-z]{4,}/.test(w) && !STOP.includes(w)))];
  const hits = words.filter(w => hay.includes(w)).length;
  const pin = (String(compAddr || '').match(/\b\d{6}\b/) || [])[0];
  if ((pin && hay.includes(pin) && hits >= 1) || hits >= 2) return 'address';
  return '';
}

// Parses the text of a Delhivery "Print POD for Return Dispatch" PDF. pages = array of arrays of text lines.
export function parsePodText(pages, pageOffset){
  const meta = { courier: '', dispatch_id: '', dispatch_datetime: '' };
  const sections = []; let cur = null, inHeader = false;
  pages.forEach((lines, pi) => {
    const page = (pageOffset || 0) + pi + 1;
    lines.forEach(line => {
      const t = line.trim(); if (!t) return;
      let m;
      if (!meta.dispatch_id && (m = t.match(/Dispatch ID:\s*([0-9A-Z]+)/i))) meta.dispatch_id = m[1];
      if (!meta.dispatch_datetime && (m = t.match(/(\d{1,2}-[A-Za-z]{3}-\d{4}\s*·?\s*\d{1,2}:\d{2}\s*[AP]M)/))) meta.dispatch_datetime = m[1];
      if (!meta.courier && /DELHIVERY/i.test(t)) meta.courier = 'Delhivery';
      if (/^(Mark in box|Page \d+ of \d+|https?:\/\/|Dispatch ID|FE \/ Helper)/i.test(t)) return;
      if ((m = t.match(/^(\d{1,3})\.\s+([A-Za-z].*)$/))){               // "1. Pokonut   GOEX 250 GM SURFACE   OTP"
        const parts = m[2].split(/\s{2,}/).map(s => s.trim()).filter(Boolean);
        cur = { no: +m[1], page, company: parts[0] || '', service: parts.slice(1).filter(p => !/^OTP$/i.test(p)).join(' '),
                header: m[2].replace(/\s+/g, ' '), declared: null, rows: [], cont: false };
        sections.push(cur); inHeader = true; return;
      }
      const awbs = [...t.matchAll(/(?:^|\s)(\d{1,3})\.\s+([0-9A-Z]{8,})(?=\s|$)/g)];
      if (awbs.length){
        if (!cur){ cur = { no: 0, page, company: '', service: '', header: '', declared: null, rows: [], cont: true }; sections.push(cur); }
        inHeader = false;
        awbs.forEach(a => cur.rows.push({ page, serial: +a[1], awb: a[2], partial: false, mark: '' }));
        return;
      }
      if (cur && inHeader){
        if (cur.declared == null && (m = t.match(/(\d+)\s*pkgs?\b/i))) cur.declared = +m[1];
        cur.header += ' ' + t.replace(/\s+/g, ' ');
      }
    });
  });
  return { meta, sections };
}

export function isAwbLike(a){ return /^[0-9A-Z]{8,22}$/.test(a) && (a.match(/\d/g) || []).length >= 8; }
export function ignoredPrefix(awb, prefixes){
  const list = (Array.isArray(prefixes) ? prefixes : String(prefixes || '').split(',')).map(x => normAwb(x)).filter(Boolean);
  return list.find(p => awb.startsWith(p) && /\d{6,}/.test(awb.slice(p.length)));
}
// Live check of one scanned AWB against the POD rows: 'on' | 'near' (1 digit off) | 'off' | null (no POD yet)
export function podLookup(pod, awb){
  if (!pod.length) return null;
  for (const r of pod){
    const p = normAwb(r.awb);
    if (!p) continue;
    if (!r.partial && p === awb) return 'on';
    if (r.partial && p.length >= 4 && awb.endsWith(p)) return 'on';
    if (!r.partial && p.length >= 16 && p.length === awb.length && awb.slice(0, 15) === p.slice(0, 15) && /^0+$/.test(awb.slice(15))) return 'on';
  }
  for (const r of pod){ const p = normAwb(r.awb); if (!r.partial && p.length === awb.length && hamming(p, awb) <= 1) return 'near'; }
  return 'off';
}
export const STATUS = {
  matched:             { label: 'Matched',                 cls: 'p-ok' },
  verify:              { label: 'Verify (1 digit off)',    cls: 'p-warn' },
  conflict:            { label: '✗ on POD but scanned',    cls: 'p-warn' },
  damaged:             { label: 'Damaged (D)',             cls: 'p-warn' },
  not_received_marked: { label: 'Not received (✗ marked)', cls: 'p-info' },
  pod_not_scanned:     { label: 'On POD, not scanned',     cls: 'p-bad' },
  pod_duplicate:       { label: 'Listed twice on POD',     cls: 'p-info' },
  scan_not_on_pod:     { label: 'Scanned, not on POD',     cls: 'p-bad' }
};
