let authToken = null;
let nextPageToken = null;
let isFetching = false;
let allItems = [];
let currentFilter = 'all';
let selectedAids = new Set();

document.addEventListener('DOMContentLoaded', () => {
  chrome.storage?.local.get(['cache'], (res) => {
    if (res.cache) {
      allItems = res.cache;
      updateStats(allItems);
      applyFilters();
    }
  });

  document.getElementById('searchInput').addEventListener('input', applyFilters);
  document.getElementById('dateFilter').addEventListener('change', applyFilters);
  document.getElementById('downloadZip').addEventListener('click', downloadAsZip);
  document.getElementById('lightbox').onclick = () => { document.getElementById('lightbox').style.display = 'none'; };

  document.querySelectorAll('.stat-item').forEach(item => {
    item.addEventListener('click', () => {
      currentFilter = item.dataset.filter;
      applyFilters();
    });
  });

  const container = document.getElementById('scroll-container');
  container.addEventListener('scroll', () => {
    if (container.scrollTop + container.clientHeight >= container.scrollHeight - 20) {
      if (nextPageToken && !isFetching) fetchNextBatch();
    }
  });
});

function applyFilters() {
    const term = document.getElementById('searchInput').value.toLowerCase();
    const dateVal = document.getElementById('dateFilter').value;
    let filtered = allItems;

    const now = new Date();
    if (dateVal === 'today') filtered = filtered.filter(i => new Date(i.ts).toDateString() === now.toDateString());
    if (dateVal === 'week') filtered = filtered.filter(i => (now - new Date(i.ts)) / (1000*60*60*24) <= 7);

    if (currentFilter !== 'all') {
        if (currentFilter === 'image') filtered = filtered.filter(i => i.mime?.includes('image'));
        else if (currentFilter === 'file') filtered = filtered.filter(i => i.type === 'file' && !i.mime?.includes('image'));
        else if (currentFilter === 'link') filtered = filtered.filter(i => i.type === 'link');
    }

    if (term) filtered = filtered.filter(i => (i.name || i.url || "").toLowerCase().includes(term));
    renderUI(filtered);
}

async function fetchNextBatch(isNew = false) {
  if (isFetching) return;
  isFetching = true;
  document.getElementById('status').innerText = 'סורק הודעות...';

  try {
    if (!authToken) authToken = await new Promise(res => chrome.identity.getAuthToken({interactive:true}, res));
    let url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=15&q=label:INBOX+(has:attachment OR "http")&fields=messages(id),nextPageToken`;
    if (nextPageToken) url += `&pageToken=${nextPageToken}`;

    const res = await fetch(url, { headers: { Authorization: `Bearer ${authToken}` } });
    const data = await res.json();
    nextPageToken = data.nextPageToken;

    const details = await Promise.all((data.messages || []).map(m => 
      fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?fields=id,payload,internalDate`, {
        headers: { Authorization: `Bearer ${authToken}` }
      }).then(r => r.json())
    ));

    const newItems = processMessages(details);
    allItems = isNew ? newItems : [...allItems, ...newItems];
    updateStats(allItems);
    applyFilters();
    chrome.storage.local.set({ cache: allItems });
    document.getElementById('status').innerText = '';
  } catch (e) {
    document.getElementById('status').innerText = 'שגיאה בחיבור';
  } finally { isFetching = false; }
}

function processMessages(details) {
  const found = [];
  const linkReg = /https?:\/\/[^\s"<>]{15,}/g;

  details.forEach(msg => {
    const ts = parseInt(msg.internalDate);
    const date = new Date(ts).toLocaleDateString('he-IL');
    const scan = (parts) => {
      if(!parts) return;
      parts.forEach(p => {
        if (p.filename && (p.body?.attachmentId || p.body?.data)) {
          found.push({ type:'file', id:msg.id, aid:p.body.attachmentId || p.partId, name:p.filename, mime:p.mimeType, date, ts });
        }
        if (p.body?.data) {
          try {
            const txt = atob(p.body.data.replace(/-/g, '+').replace(/_/g, '/'));
            const links = txt.match(linkReg);
            if (links) links.forEach(l => {
              if (!l.includes('google.com')) found.push({ type:'link', url:l, date, ts });
            });
          } catch(e){}
        }
        if (p.parts) scan(p.parts);
      });
    };
    scan(msg.payload.parts || [msg.payload]);
  });
  return found.filter((v, i, a) => a.findIndex(t => (t.aid === v.aid && t.url === v.url)) === i);
}

function renderUI(items) {
  const list = document.getElementById('itemsList');
  list.innerHTML = '';
  items.forEach(item => {
    const card = document.createElement('div');
    card.className = 'card';
    const isImg = item.mime?.includes('image');
    const badge = item.mime?.includes('pdf') ? 'bg-pdf' : isImg ? 'bg-img' : 'bg-excel';
    
    card.innerHTML = `
      ${item.type==='file' ? `<input type="checkbox" class="select-item" data-aid="${item.aid}" ${selectedAids.has(item.aid)?'checked':''}>` : ''}
      <div class="preview" id="p-${item.aid}">${isImg ? '🖼️' : (item.type==='link' ? '🌐' : '📄')}</div>
      <div class="card-body">
        <div class="title">${item.name || 'קישור חיצוני'}</div>
        <div class="meta">${item.date} ${item.mime ? `<span class="badge ${badge}">${item.mime.split('/')[1].toUpperCase()}</span>` : ''}</div>
        <div class="actions">
          ${item.type==='file' ? `<button class="btn-act open" data-mid="${item.id}" data-aid="${item.aid}" data-mime="${item.mime}">צפה</button>
          <button class="btn-act down" data-mid="${item.id}" data-aid="${item.aid}" data-mime="${item.mime}" data-name="${item.name}">הורד</button>` : 
          `<button class="btn-act link-btn" data-url="${item.url}">בקר ➔</button>`}
        </div>
      </div>`;
    list.appendChild(card);
    if (isImg) loadThumb(item);
  });
}

async function downloadAsZip() {
    if (selectedAids.size === 0) return;
    const zip = new JSZip();
    document.getElementById('status').innerText = 'מכין ZIP...';
    for (let aid of selectedAids) {
        const item = allItems.find(i => i.aid === aid);
        const raw = await getRaw(item.id, item.aid);
        zip.file(item.name, raw, {base64: true});
    }
    const content = await zip.generateAsync({type:"blob"});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(content);
    a.download = "G-Collector_Files.zip";
    a.click();
    document.getElementById('status').innerText = '';
}

function updateStats(items) {
    document.getElementById('count-all').innerText = items.length;
    document.getElementById('count-files').innerText = items.filter(i => i.type==='file' && !i.mime?.includes('image')).length;
    document.getElementById('count-imgs').innerText = items.filter(i => i.mime?.includes('image')).length;
    document.getElementById('count-links').innerText = items.filter(i => i.type==='link').length;
}

document.addEventListener('change', e => {
    if (e.target.classList.contains('select-item')) {
        const aid = e.target.dataset.aid;
        if (e.target.checked) selectedAids.add(aid); else selectedAids.delete(aid);
        document.getElementById('downloadZip').innerText = `ZIP (${selectedAids.size})`;
    }
});

document.addEventListener('click', async e => {
    const t = e.target;
    if (t.id === 'fetchBtn') { nextPageToken = null; fetchNextBatch(true); }
    if (t.classList.contains('link-btn')) window.open(t.dataset.url);
    if (t.tagName === 'IMG' || t.classList.contains('preview')) {
        const src = t.tagName === 'IMG' ? t.src : t.querySelector('img')?.src;
        if (src) { document.querySelector('#lightbox img').src = src; document.getElementById('lightbox').style.display='flex'; }
    }
    if (t.classList.contains('open') || t.classList.contains('down')) {
        const d = t.dataset; const raw = await getRaw(d.mid, d.aid);
        const url = URL.createObjectURL(new Blob([new Uint8Array(atob(raw).split("").map(c => c.charCodeAt(0)))], {type:d.mime}));
        if (t.classList.contains('open')) window.open(url); else { const a = document.createElement('a'); a.href = url; a.download = d.name; a.click(); }
    }
});

async function loadThumb(item) {
    const data = await getRaw(item.id, item.aid);
    const el = document.getElementById(`p-${item.aid}`);
    if (el) el.innerHTML = `<img src="data:${item.mime};base64,${data}">`;
}

async function getRaw(mid, aid) {
    const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${mid}/attachments/${aid}`, {
        headers: { Authorization: `Bearer ${authToken}` }
    });
    const d = await r.json(); return d.data.replace(/-/g, '+').replace(/_/g, '/');
}