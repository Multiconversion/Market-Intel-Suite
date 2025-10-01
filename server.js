// ========= Utils =========
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function uniqNorm(arr){ 
  const s=new Set(); const out=[]; 
  for(const x of arr||[]){ 
    const t=String(x||"").toLowerCase().trim(); 
    if(t && !s.has(t)){ s.add(t); out.push(t); } 
  } 
  return out; 
}

// ========= (NUEVO) Sanitizador de keywords =========
function sanitizeKeywords(keywords) {
  const MAX_LEN = 80; // seguro para DataForSEO
  const BAD_CHARS = /[?¿“”"<>#%{}|\\^~\[\]]/g; 

  const cleaned = [];
  const rejected = [];

  for (let kw of keywords || []) {
    if (!kw) continue;
    let k = String(kw)
      .normalize("NFKC")       // normaliza unicode
      .replace(BAD_CHARS, " ") // quita símbolos problemáticos
      .replace(/\s+/g, " ")    // colapsa espacios
      .trim();

    if (k.length > MAX_LEN) k = k.slice(0, MAX_LEN).trim();

    if (!k || k.length < 2) { rejected.push(kw); continue; }

    cleaned.push(k);
  }
  return { cleaned: uniqNorm(cleaned), rejected };
}


