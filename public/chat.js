// Shanti & Bryan Pinscher Kennel — AI Chat Widget
(function () {

  document.head.insertAdjacentHTML('beforeend', `<style>
    #kBtn {
      position: fixed !important;
      bottom: 80px !important;
      right: 20px !important;
      width: 54px !important;
      height: 54px !important;
      border-radius: 50% !important;
      background: linear-gradient(135deg, #7a1e1e, #a83232) !important;
      color: white !important;
      border: none !important;
      cursor: pointer !important;
      z-index: 2147483647 !important;
      box-shadow: 0 4px 18px rgba(122,31,31,.55) !important;
      font-size: 1.35rem !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      transition: transform .2s !important;
      padding: 0 !important; margin: 0 !important;
      top: auto !important; left: auto !important;
    }
    #kBtn:hover { transform: scale(1.08) !important; }
    #kBtn .kN {
      position: absolute !important;
      top: -4px !important; right: -4px !important;
      background: #c9a227 !important;
      color: #0d1117 !important;
      width: 18px !important; height: 18px !important;
      border-radius: 50% !important;
      border: 2px solid white !important;
      font-size: 9px !important; font-weight: 800 !important;
      display: flex !important;
      align-items: center !important; justify-content: center !important;
      font-family: sans-serif !important;
    }
    #kWin, #kMsgs, .kb, .kqr, #kInp, .kNm, .kSt {
      font-family: 'Poppins', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important;
      -webkit-font-smoothing: antialiased;
    }
    .kb { letter-spacing: 0.1px; }
    #kWin {
      position: fixed !important;
      bottom: 144px !important; right: 20px !important;
      width: 320px !important;
      max-width: calc(100vw - 40px) !important;
      height: 480px !important;
      max-height: calc(100vh - 160px) !important;
      background: white !important;
      border-radius: 16px !important;
      box-shadow: 0 8px 36px rgba(0,0,0,.2) !important;
      z-index: 2147483646 !important;
      display: none !important;
      flex-direction: column !important;
      overflow: hidden !important;
      top: auto !important; left: auto !important;
    }
    #kWin.on { display: flex !important; }
    #kHead {
      background: linear-gradient(135deg, #0d1117, #1a2433);
      padding: 13px 15px; display: flex; align-items: center; gap: 10px; flex-shrink: 0;
    }
    .kAv {
      width: 38px; height: 38px; border-radius: 50%;
      overflow: hidden; flex-shrink: 0;
      border: 2px solid #c9a227;
    }
    .kAv img { width: 100%; height: 100%; object-fit: cover; }
    .kInf { flex: 1; }
    .kNm { color: white; font-weight: 800; font-size: .88rem; font-family: 'Poppins', sans-serif; }
    .kSt { color: #7a9ab8; font-size: .68rem; display: flex; align-items: center; gap: 4px; margin-top: 2px; }
    .kDt { width: 6px; height: 6px; border-radius: 50%; background: #22c55e; animation: kp 2s infinite; }
    @keyframes kp{0%,100%{opacity:1}50%{opacity:.4}}
    #kClose {
      background: rgba(255,255,255,.12); border: none; color: white;
      width: 26px; height: 26px; border-radius: 50%; cursor: pointer;
      font-size: .8rem; display: flex; align-items: center; justify-content: center;
    }
    #kClose:hover { background: rgba(255,255,255,.2); }
    #kMsgs {
      flex: 1; overflow-y: auto; padding: 12px;
      display: flex; flex-direction: column; gap: 9px; background: #f9f7f4;
    }
    #kMsgs::-webkit-scrollbar{width:3px}
    #kMsgs::-webkit-scrollbar-thumb{background:#e2ddd5;border-radius:2px}
    .km{display:flex;gap:7px;align-items:flex-end}
    .km.u{flex-direction:row-reverse}
    .kav{width:26px;height:26px;border-radius:50%;overflow:hidden;flex-shrink:0;border:1.5px solid #c9a227;}
    .kav img{width:100%;height:100%;object-fit:cover;}
    .kav.u{background:linear-gradient(135deg,#7a1e1e,#a83232);display:flex;align-items:center;justify-content:center;font-size:.6rem;color:white;border:none;}
    .kb{max-width:82%;padding:9px 13px;border-radius:14px;font-size:.81rem;line-height:1.6;font-family:'Poppins',sans-serif;word-break:break-word}
    .kb.b{background:white;color:#1e293b;border-bottom-left-radius:3px;box-shadow:0 1px 4px rgba(0,0,0,.08);border:1px solid #ece5d8}
    .kb.u{background:linear-gradient(135deg,#7a1e1e,#a83232);color:white;border-bottom-right-radius:3px}
    .kdts{display:flex;gap:3px;padding:3px 1px}
    .kdts span{width:5px;height:5px;background:#c9a227;border-radius:50%;animation:kdb .9s ease-in-out infinite;opacity:.5}
    .kdts span:nth-child(2){animation-delay:.15s}.kdts span:nth-child(3){animation-delay:.3s}
    @keyframes kdb{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-4px)}}
    #kQR{padding:7px 9px 5px;display:flex;gap:5px;flex-wrap:wrap;background:#f9f7f4;border-top:1px solid #ece5d8;flex-shrink:0}
    .kqr{background:white;border:1px solid #c9a227;color:#7a1e1e;padding:4px 10px;border-radius:20px;font-size:.7rem;font-weight:600;cursor:pointer;font-family:'Poppins',sans-serif;white-space:nowrap}
    .kqr:hover{background:#7a1e1e;color:white;border-color:#7a1e1e}
    #kFoot{padding:9px 11px;display:flex;gap:7px;align-items:flex-end;background:white;border-top:1px solid #ece5d8;flex-shrink:0}
    #kInp{flex:1;border:1.5px solid #e6ddc8;border-radius:9px;padding:8px 11px;font-size:.81rem;font-family:'Poppins',sans-serif;resize:none;outline:none;line-height:1.5;color:#1e293b;max-height:70px}
    #kInp:focus{border-color:#c9a227}
    #kSend{width:36px;height:36px;border-radius:9px;background:linear-gradient(135deg,#7a1e1e,#a83232);color:white;border:none;cursor:pointer;font-size:.85rem;display:flex;align-items:center;justify-content:center;flex-shrink:0}
    #kSend:disabled{opacity:.4;cursor:not-allowed}
    #kBrand{text-align:center;padding:5px 0;font-size:.6rem;color:#b8a99a;font-family:'Poppins',sans-serif;}
    @media(max-width:400px){
      #kWin{right:10px !important;width:calc(100vw - 20px) !important}
      #kBtn{right:14px !important}
    }
  </style>`);

  document.body.insertAdjacentHTML('beforeend', `
    <button id="kBtn"><i class="fa-solid fa-paw"></i><span class="kN">1</span></button>
    <div id="kWin">
      <div id="kHead">
        <div class="kAv"><img src="/images/images/emblem.png" alt="Bella" onerror="this.parentNode.innerHTML='<i class=\\'fa-solid fa-paw\\'></i>'"></div>
        <div class="kInf">
          <div class="kNm">Bella · Kennel Assistant</div>
          <div class="kSt"><span class="kDt"></span> Online · replies instantly</div>
        </div>
        <button id="kClose"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div id="kMsgs"></div>
      <div id="kQR"></div>
      <div id="kFoot">
        <textarea id="kInp" placeholder="Ask me anything…" rows="1"></textarea>
        <button id="kSend"><i class="fa-solid fa-paper-plane"></i></button>
      </div>
      <div id="kBrand">Powered by AI · Shanti & Bryan Pinscher Kennel</div>
    </div>
  `);

  let isOpen = false, busy = false;
  const STORAGE_KEY = 'sbk_bella_chat_history';
  let hist = [];
  try {
    const saved = sessionStorage.getItem(STORAGE_KEY);
    if (saved) hist = JSON.parse(saved);
  } catch(e) { hist = []; }
  function saveHist() {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(hist.slice(-30))); } catch(e) {}
  }
  const wait = ms => new Promise(r => setTimeout(r, ms));

  function toggle() {
    isOpen = !isOpen;
    document.getElementById('kWin').classList.toggle('on', isOpen);
    const ic = document.getElementById('kBtn').querySelector('i');
    if (ic) ic.className = isOpen ? 'fa-solid fa-xmark' : 'fa-solid fa-paw';
    const badge = document.getElementById('kBtn').querySelector('.kN');
    if (badge) badge.remove();
    if (isOpen && document.getElementById('kMsgs').children.length === 0) {
      if (hist.length > 0) {
        hist.forEach(m => addMsg(m.r === 'assistant' ? 'assistant' : 'user', m.t));
        setQR(['Available puppies', 'How to reserve a puppy', 'Do you deliver?', 'About Min Pins']);
      } else {
        setTimeout(welcome, 200);
      }
    }
  }

  function addMsg(role, text) {
    const w = document.createElement('div');
    w.className = 'km' + (role === 'user' ? ' u' : '');
    const avatar = role === 'user'
      ? `<div class="kav u"><i class="fa-solid fa-user" style="font-size:.55rem"></i></div>`
      : `<div class="kav"><img src="/images/images/emblem.png" alt="" onerror="this.parentNode.innerHTML='<i class=\\'fa-solid fa-paw\\'></i>'"></div>`;
    w.innerHTML = `${avatar}<div class="kb ${role === 'user' ? 'u' : 'b'}">${fmt(text)}</div>`;
    document.getElementById('kMsgs').appendChild(w);
    scr();
  }

  function fmt(t) {
    return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>')
      .replace(/\*(.*?)\*/g,'<em>$1</em>')
      .replace(/\n/g,'<br>');
  }

  function showTyping() {
    const w = document.createElement('div'); w.className = 'km'; w.id = 'kTyping';
    w.innerHTML = `<div class="kav"><img src="/images/images/emblem.png" alt="" onerror="this.parentNode.innerHTML='<i class=\\'fa-solid fa-paw\\'></i>'"></div><div class="kb b"><div class="kdts"><span></span><span></span><span></span></div></div>`;
    document.getElementById('kMsgs').appendChild(w); scr();
  }
  function hideTyping() { const t = document.getElementById('kTyping'); if (t) t.remove(); }

  function setQR(list) {
    const el = document.getElementById('kQR'); el.innerHTML = '';
    (list || []).forEach(item => {
      const b = document.createElement('button'); b.className = 'kqr';
      b.textContent = typeof item === 'string' ? item : item.label;
      b.onclick = () => {
        if (typeof item === 'object' && item.href) window.location.href = item.href;
        else send(typeof item === 'string' ? item : item.label);
      };
      el.appendChild(b);
    });
  }

  function scr() { const m = document.getElementById('kMsgs'); m.scrollTop = m.scrollHeight; }

  async function callAI(userText) {
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userText, history: hist.slice(-10) })
      });
      const data = await res.json();
      return data.reply || null;
    } catch { return null; }
  }

  async function welcome() {
    showTyping(); await wait(700); hideTyping();
    const t = `Hi there! I'm **Bella**, your assistant at Shanti & Bryan Pinscher Kennel.\n\nI can help you with:\n• **Available puppies** & pricing\n• **Deposits** & how to reserve\n• **Delivery** & local pickup\n• **Health guarantees** & vaccinations\n• **Breed information** about Min Pins\n\nWhat can I help you with today?`;
    addMsg('assistant', t); hist.push({ r: 'assistant', t }); saveHist();
    setQR(['Available puppies', 'How to reserve a puppy', 'Do you deliver?', 'About Min Pins']);
  }

  async function send(text) {
    text = (text || document.getElementById('kInp').value).trim();
    if (!text || busy) return;
    busy = true;
    document.getElementById('kInp').value = '';
    document.getElementById('kQR').innerHTML = '';
    resize();
    addMsg('user', text);
    hist.push({ r: 'user', t: text }); saveHist();
    document.getElementById('kSend').disabled = true;

    showTyping();
    const reply = await callAI(text);
    hideTyping();

    if (reply) {
      addMsg('assistant', reply); hist.push({ r: 'assistant', t: reply }); saveHist();
      const low = reply.toLowerCase();
      const q = [];
      if (low.includes('puppies') || low.includes('available')) q.push({ label: 'View Available Puppies', href: '/puppies' });
      if (low.includes('contact') || low.includes('reach')) q.push({ label: 'Contact Us', href: '/contact' });
      if (low.includes('deposit') || low.includes('reserve')) q.push({ label: 'Deposit Info', href: '/deposit' });
      if (low.includes('deliver') || low.includes('pickup')) q.push({ label: 'Adoption Process', href: '/process' });
      if (q.length === 0) q.push('Tell me more', { label: 'View Puppies', href: '/puppies' }, { label: 'Contact Us', href: '/contact' });
      setQR(q.slice(0, 3));
    } else {
      const m = `I'm having a moment — please try again or reach us at **info@shantibryankennel.com** and we'll respond shortly!`;
      addMsg('assistant', m); hist.push({ r: 'assistant', t: m }); saveHist();
      setQR([{ label: 'Contact Us', href: '/contact' }, { label: 'View Puppies', href: '/puppies' }]);
    }

    busy = false;
    document.getElementById('kSend').disabled = false;
  }

  function resize() {
    const t = document.getElementById('kInp');
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 70) + 'px';
  }

  document.getElementById('kBtn').addEventListener('click', toggle);
  document.getElementById('kClose').addEventListener('click', toggle);
  document.getElementById('kSend').addEventListener('click', () => send());
  document.getElementById('kInp').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  document.getElementById('kInp').addEventListener('input', resize);

})();
