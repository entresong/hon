// ============================================================
// 魂 (혼) — 권위 게임 서버 (배포판)
// HTTP로 게임 화면(client.html)을 서빙하고, 같은 포트에서 WebSocket으로 세계를 돌린다.
// 실행: node server.js → 브라우저에서 http://localhost:8787 접속
//
// 원칙: 서버가 모든 판정을 한다. client.html은 '의도'(이동/공격/줍기/착용/구매)만 보낸다.
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8787;
const TICK = 50;
const WORLD = 1600;
const PLAYER_SPEED = 170;
const ATTACK_CD = 600;
const MONSTER_COUNT = 24;
const SOUL_PRIORITY_MS = 5000;
const DEATH_MS = 440;          // 몬스터 사망 연출 동안 잔존 (추가 타격 불가). client.html의 DEATH_MS는 이보다 작아야 연출이 제거 전에 끝난다
const REGEN_HP = 2.4;
const REGEN_MP = 1.6;

// ---------- 마을: 상점이 있는 시작 지대 (잡몹이 스폰되지 않는다) ----------
const VILLAGE = { x: 350, y: WORLD - 180, r: 170 };

// ---------- 직업(전직) 정의 ----------
// 레벨 5에 전직 가능(1회). 무사=근접 강타, 음양사=원거리 주술(MP 소모·혼 보너스), 궁사=원거리 사격(빠름)
const ONMYO_MP = 3;   // 음양사 주술 1회 MP 소모
const JOBS = {
  warrior: { name:'무사',   range:38,  speed:170, atkBonus:4, hpBonus:40, mpBonus:0,  ranged:false },
  onmyoji: { name:'음양사', range:240, speed:165, atkBonus:2, hpBonus:0,  mpBonus:40, ranged:true  },
  archer:  { name:'궁사',   range:220, speed:215, atkBonus:3, hpBonus:10, mpBonus:0,  ranged:true  },
};

// ---------- 장비 정의: 모든 수치의 유일한 원천(서버) ----------
// slot : weapon/body/feet/head | atk:공격 가산 def:방어(피해 감소) | price:상점가(魂) | src:start/shop | job:직업 제한
const SLOTS = ['weapon', 'body', 'feet', 'head'];
const EQUIP = {
  // 무기
  scythe:      { slot:'weapon', name:'낫',   atk:0,  def:0, price:0,   src:'start' },
  bspear:      { slot:'weapon', name:'죽창', atk:4,  def:0, price:45,  src:'shop' },
  hwando:      { slot:'weapon', name:'환도', atk:12, def:0, price:120, src:'shop', job:'warrior' },
  talisman:    { slot:'weapon', name:'부적', atk:10, def:0, price:110, src:'shop', job:'onmyoji' },
  longbow:     { slot:'weapon', name:'장궁', atk:11, def:0, price:115, src:'shop', job:'archer' },
  // 몸통
  hemprobe:    { slot:'body', name:'삼베옷',   atk:0, def:0,  price:0,   src:'start' },
  leathervest: { slot:'body', name:'가죽 배자', atk:0, def:3,  price:55,  src:'shop' },
  armor:       { slot:'body', name:'갑주',   atk:0, def:10, price:130, src:'shop', job:'warrior' },
  dopo:        { slot:'body', name:'도포',   atk:0, def:6,  price:100, src:'shop', job:'onmyoji' },
  leatherrobe: { slot:'body', name:'가죽옷', atk:0, def:7,  price:105, src:'shop', job:'archer' },
  // 발
  straw:       { slot:'feet', name:'짚신',   atk:0, def:0, price:0,  src:'start' },
  leathershoe: { slot:'feet', name:'가죽신', atk:0, def:2, price:30, src:'shop' },
  // 머리
  sakkat:      { slot:'head', name:'삿갓',   atk:0, def:1, price:25, src:'shop' },
};
const START_GEAR = { weapon:'scythe', body:'hemprobe', feet:'straw', head:null };
const SHOP_KEYS = Object.keys(EQUIP).filter(k => EQUIP[k].src === 'shop');
const COMMON_DROPS = SHOP_KEYS.filter(k => !EQUIP[k].job);   // 직업 무관 (잡몹 저확률 드랍)
const BOSS_DROPS   = SHOP_KEYS.filter(k =>  EQUIP[k].job);   // 직업 상위 장비 (보스 드랍)

// 안전한 장비 조회: 클라가 보낸 키가 EQUIP 고유 키일 때만 반환 (프로토타입 키 'constructor' 등 차단)
function eqOf(k){ return (typeof k === 'string' && Object.prototype.hasOwnProperty.call(EQUIP, k)) ? EQUIP[k] : null; }

// 착용 장비로부터 실효 공격력/방어력을 계산 (항상 서버가 산출)
function effAtk(p){ return p.atk + (EQUIP[p.equip.weapon]?.atk || 0); }
function effDef(p){ let d = 0; for(const s of SLOTS){ const k = p.equip[s]; if(k) d += EQUIP[k]?.def || 0; } return d; }

// ---------- HTTP: 게임 화면 서빙 ----------
const httpServer = http.createServer((req, res) => {
  if(req.url === '/' || req.url === '/index.html'){
    fs.readFile(path.join(__dirname, 'client.html'), (err, data) => {
      if(err){ res.writeHead(500); res.end('client.html 없음'); return; }
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
      res.end(data);
    });
  } else { res.writeHead(404); res.end(); }
});

const players = new Map();
const monsters = new Map();
const souls = new Map();
const drops = new Map();   // 땅에 떨어진 장비 전리품
let nextId = 1;
const nid = (p) => p + (nextId++);

function rnd(n){ return Math.random()*n; }
function dist(a,b){ return Math.hypot(a.x-b.x, a.y-b.y); }
function spawnPos(){ return { x: VILLAGE.x - 60 + rnd(120), y: VILLAGE.y - 40 + rnd(80) }; }

function spawnMonster(){
  let x, y;
  do { x = 80 + rnd(WORLD-160); y = 80 + rnd(WORLD-160); }
  while(Math.hypot(x-VILLAGE.x, y-VILLAGE.y) < VILLAGE.r + 40);   // 마을 안에는 스폰 금지
  const tier = 1 + Math.floor(rnd(3));
  monsters.set(nid('m'), {
    x, y, tier, boss:false,
    hp: 20*tier, maxHp: 20*tier, atk: 3+tier*2,
    wander: rnd(Math.PI*2), aggroId: null,
    damage: new Map(), lastHitAt: 0, dying: false, dieAt: 0,
  });
}
function spawnBoss(){
  // 보스(鬼將)는 마을 반대편(북쪽)을 배회한다
  monsters.set(nid('m'), {
    x: 200 + rnd(WORLD-400), y: 120 + rnd(360),
    tier: 4, boss: true,
    hp: 340, maxHp: 340, atk: 21,
    wander: rnd(Math.PI*2), aggroId: null,
    damage: new Map(), lastHitAt: 0, dying: false, dieAt: 0,
  });
}
for(let i=0;i<MONSTER_COUNT;i++) spawnMonster();
spawnBoss();

// ---------- WebSocket: 같은 서버에 부착 ----------
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  const id = nid('p');
  ws.on('message', (raw) => {
    let m; try{ m = JSON.parse(raw); }catch(e){ return; }

    if(m.t === 'join'){
      const name = String(m.name||'무명천민').slice(0,10);
      const s = spawnPos();
      players.set(id, { ws, name,
        x: s.x, y: s.y, tx:null, ty:null,
        hp: 60, maxHp: 60, mp: 30, maxMp: 30, atk: 7, range: 34, speed: PLAYER_SPEED,
        level: 1, exp: 0, soul: 0, lastAtk: 0, respawnAt: 0, attackId: null,
        lastDamagedAt: 0, job: null, jobOffered: false,
        inv: new Set(['scythe','hemprobe','straw']),   // 시작 지급: 낫 + 삼베옷 + 짚신
        equip: { ...START_GEAR } });
      const p = players.get(id);
      ws.send(JSON.stringify({ t:'welcome', id, world: WORLD,
        village: VILLAGE, equipDefs: EQUIP, shop: SHOP_KEYS }));
      sendSelf(p);
      return;
    }
    const p = players.get(id);
    if(!p || p.respawnAt > Date.now()) return;

    if(m.t === 'move'){
      p.tx = Math.max(20, Math.min(WORLD-20, +m.x||0));
      p.ty = Math.max(20, Math.min(WORLD-20, +m.y||0));
      p.attackId = null;
    }
    if(m.t === 'attack'){
      const mo = monsters.get(m.id);
      if(mo && !mo.dying) { p.attackId = m.id; p.tx = p.ty = null; }
    }
    if(m.t === 'loot'){
      const s = souls.get(m.id);
      if(!s) return;
      const now = Date.now();
      const canLoot = (now >= s.unlockAt) || (s.ownerId === id);
      if(canLoot && dist(p, s) < 40){
        let amt = s.amount;
        if(p.job === 'onmyoji') amt = Math.round(amt * 1.5);   // 음양사 혼 획득 보너스
        p.soul += amt;
        souls.delete(m.id);
        send(p.ws, { t:'msg', k:'g', text:`+${amt} 魂` });
        sendSelf(p);
      } else if(!canLoot && dist(p,s) < 40){
        send(p.ws, { t:'msg', k:'b', text:'아직 임자가 있는 혼이다 (5초 후 무주공산)' });
      }
    }
    if(m.t === 'pickup'){
      const d = drops.get(m.id);
      if(!d) return;
      const now = Date.now();
      const canLoot = (now >= d.unlockAt) || (d.ownerId === id);
      if(canLoot && dist(p, d) < 40){
        const it = EQUIP[d.key];
        if(p.inv.has(d.key)){
          p.soul += 5;
          send(p.ws, { t:'msg', k:'g', text:`이미 지닌 ${it.name} — +5 魂` });
        } else {
          p.inv.add(d.key);
          send(p.ws, { t:'msg', k:'g', text:`${it.name} 획득` });
        }
        drops.delete(m.id);
        sendSelf(p);
      } else if(!canLoot && dist(p,d) < 40){
        send(p.ws, { t:'msg', k:'b', text:'아직 임자가 있는 전리품이다 (5초 후 풀린다)' });
      }
    }
    if(m.t === 'equip'){
      const key = m.key, it = eqOf(key);
      if(it && p.inv.has(key) && (!it.job || it.job === p.job)){   // 직업 제한 장비는 해당 직업만
        p.equip[it.slot] = key;
        sendSelf(p);
      }
    }
    if(m.t === 'unequip'){
      if(SLOTS.includes(m.slot) && p.equip[m.slot]){
        p.equip[m.slot] = null;
        sendSelf(p);
      }
    }
    if(m.t === 'buy'){
      const key = m.key, it = eqOf(key);
      if(!it || it.src !== 'shop') return;
      if(it.job && it.job !== p.job){ send(p.ws,{t:'msg',k:'b',text:'직업에 맞지 않는 장비다'}); return; }
      if(dist(p, VILLAGE) > VILLAGE.r){ send(p.ws,{t:'msg',k:'b',text:'상점은 마을 안에서만 이용할 수 있다'}); return; }
      if(p.inv.has(key)){ send(p.ws,{t:'msg',k:'b',text:'이미 지닌 장비다'}); return; }
      if(p.soul < it.price){ send(p.ws,{t:'msg',k:'b',text:'魂이 부족하다'}); return; }
      p.soul -= it.price;
      p.inv.add(key);
      send(p.ws,{t:'msg',k:'g',text:`${it.name} 구입 (-${it.price} 魂)`});
      sendSelf(p);
    }
    if(m.t === 'job'){
      // 레벨 5 이상·미전직만 1회 전직. 서버가 직업 보너스를 적용 (m.job은 고유 키만 허용)
      if(p.level >= 5 && !p.job && Object.prototype.hasOwnProperty.call(JOBS, m.job)){
        const J = JOBS[m.job];
        p.job = m.job;
        p.range = J.range; p.speed = J.speed;
        p.atk += J.atkBonus; p.maxHp += J.hpBonus; p.maxMp += J.mpBonus;
        p.hp = p.maxHp; p.mp = p.maxMp;
        send(p.ws, { t:'msg', k:'g', text:`${J.name}(으)로 전직했다` });
        broadcast({ t:'fx', kind:'levelup', id, level: p.level });   // 전직 연출(반짝) 재사용
        sendSelf(p);
      }
    }
  });
  ws.on('close', () => {
    players.delete(id);
    // 떠난 자의 흔적 정리: 어그로/기여도에 남은 id를 지워 전리품이 유령 주인에게 묶이지 않게 한다
    for(const mo of monsters.values()){ mo.damage.delete(id); if(mo.aggroId === id) mo.aggroId = null; }
  });
});

function send(ws, obj){ try{ ws.send(JSON.stringify(obj)); }catch(e){} }
function broadcast(obj){ const s = JSON.stringify(obj); for(const p of players.values()) try{ p.ws.send(s); }catch(e){} }

// 개인 전용 정보(인벤토리·착용·실효 능력치)는 본인에게만 보낸다 — 변경 시에만
function sendSelf(p){
  send(p.ws, { t:'self', atk: effAtk(p), def: effDef(p),
    inv: [...p.inv], equip: p.equip, soul: p.soul,
    job: p.job, speed: p.speed, range: p.range });
}

// 레벨이 오를수록 가파른 곡선 (예전 level*12 → 너무 빨랐다)
function expNeed(level){ return Math.round(12 * Math.pow(level, 1.8)); }
function grantExp(p, pid, n){
  let leveled = false;
  p.exp += n;
  while(p.exp >= expNeed(p.level)){
    p.exp -= expNeed(p.level);
    p.level++;
    p.maxHp += 10;
    p.maxMp += 5;
    p.atk += 2;
    p.hp = p.maxHp;
    p.mp = p.maxMp;
    leveled = true;
    send(p.ws, { t:'msg', k:'g', text:`기량이 올랐다 — Lv ${p.level}` });
    broadcast({ t:'fx', kind:'levelup', id: pid, level: p.level });
  }
  if(leveled) sendSelf(p);   // 기본 공격력이 올랐으니 실효치 갱신
  if(p.level >= 5 && !p.job && !p.jobOffered){ p.jobOffered = true; send(p.ws, { t:'canjob' }); }   // 전직 안내(1회)
}

setInterval(() => {
  const now = Date.now();
  const dt = TICK/1000;

  for(const [pid, p] of players){
    if(p.respawnAt > now) continue;
    if(p.respawnAt && p.respawnAt <= now){
      p.respawnAt = 0; p.hp = p.maxHp; p.mp = p.maxMp;
      p.attackId = null; p.tx = p.ty = null;   // 부활 시 의도 초기화 (죽기 직전 공격으로 다시 끌려가지 않게)
      const s = spawnPos(); p.x = s.x; p.y = s.y;
    }
    const idle = !p.attackId && p.tx === null;
    const safeFromHits = now - p.lastDamagedAt > 3000;
    if(safeFromHits){
      if(idle) p.hp = Math.min(p.maxHp, p.hp + REGEN_HP*dt);   // 체력은 쉴 때만
      p.mp = Math.min(p.maxMp, p.mp + REGEN_MP*dt);            // 기력은 피격만 없으면 전투 중에도 (음양사 지속력)
    }

    if(p.attackId){
      const mo = monsters.get(p.attackId);
      if(!mo || mo.dying){ p.attackId = null; }   // 사망 연출 중이면 더는 때릴 수 없다
      else {
        const d = dist(p, mo);
        if(d > p.range + 10){
          p.x += (mo.x-p.x)/d * p.speed * dt;
          p.y += (mo.y-p.y)/d * p.speed * dt;
        } else if(now - p.lastAtk > ATTACK_CD){
          p.lastAtk = now;
          let a = effAtk(p);
          if(p.job === 'onmyoji'){
            if(p.mp >= ONMYO_MP) p.mp -= ONMYO_MP;   // 주술은 MP 소모
            else a = Math.ceil(a * 0.5);             // 기력 고갈 시 약화
          }
          mo.hp -= a;
          mo.aggroId = pid;
          mo.damage.set(pid, (mo.damage.get(pid)||0) + a);   // 경험치는 처치 시 일괄 배분
          if(p.job === 'onmyoji' || p.job === 'archer'){      // 원거리: 투사체 연출 브로드캐스트
            broadcast({ t:'fx', kind:'proj', id:pid, job:p.job,
              sx:Math.round(p.x), sy:Math.round(p.y), tx:Math.round(mo.x), ty:Math.round(mo.y) });
          }
          if(mo.hp <= 0) killMonster(mo, now);
        }
      }
    }
    else if(p.tx !== null){
      const d = Math.hypot(p.tx-p.x, p.ty-p.y);
      if(d > 4){ p.x += (p.tx-p.x)/d * p.speed * dt; p.y += (p.ty-p.y)/d * p.speed * dt; }
      else { p.tx = p.ty = null; }
    }
  }

  for(const [mid, mo] of monsters){
    if(mo.dying){ if(now >= mo.dieAt) monsters.delete(mid); continue; }   // 사망 연출 후 제거
    const tgt = mo.aggroId ? players.get(mo.aggroId) : null;
    if(tgt && !tgt.respawnAt){
      const d = dist(mo, tgt);
      const reach = mo.boss ? 30 : 22;
      if(d > 600 || dist(tgt, VILLAGE) < VILLAGE.r){ mo.aggroId = null; }   // 마을로 달아나면 추격 포기 (안전지대)
      else if(d > reach){
        const sp = (40 + mo.tier*14) * dt;
        mo.x += (tgt.x-mo.x)/d * sp; mo.y += (tgt.y-mo.y)/d * sp;
      } else if(now - mo.lastHitAt > 900){
        mo.lastHitAt = now;
        const dmg = Math.max(1, mo.atk - effDef(tgt));   // 방어력으로 피해 감소 (최소 1)
        tgt.hp -= dmg;
        tgt.lastDamagedAt = now;
        if(tgt.hp <= 0){
          const deadPid = mo.aggroId;
          const drop = Math.floor(tgt.soul/2);
          tgt.soul -= drop;
          if(drop > 0){
            souls.set(nid('s'), { x:tgt.x, y:tgt.y, amount: drop, ownerId: null, unlockAt: now, expireAt: now+60000 });
          }
          tgt.respawnAt = now + 4000;
          send(tgt.ws, { t:'msg', k:'b', text:'쓰러졌다... 혼의 절반을 그 자리에 흘렸다 (4초 후 부활)' });
          sendSelf(tgt);   // 흘린 魂 반영
          // 죽은 자를 쫓던 모든 요괴의 어그로를 푼다 (부활 직후 마을까지 쫓아오지 않도록)
          for(const om of monsters.values()){ if(om.aggroId === deadPid) om.aggroId = null; }
        }
      }
    } else {
      mo.wander += (Math.random()-0.5)*0.4;
      mo.x = Math.max(30, Math.min(WORLD-30, mo.x + Math.cos(mo.wander)*18*dt));
      mo.y = Math.max(30, Math.min(WORLD-30, mo.y + Math.sin(mo.wander)*18*dt));
    }
    // 마을(안전지대)에는 어떤 요괴도 들어오지 못하게 가장자리로 밀어낸다
    const dv = Math.hypot(mo.x - VILLAGE.x, mo.y - VILLAGE.y);
    if(dv < VILLAGE.r){ const k = VILLAGE.r / (dv || 1); mo.x = VILLAGE.x + (mo.x-VILLAGE.x)*k; mo.y = VILLAGE.y + (mo.y-VILLAGE.y)*k; }
  }

  for(const [sid, s] of souls){ if(now > s.expireAt) souls.delete(sid); }
  for(const [did, d] of drops){ if(now > d.expireAt) drops.delete(did); }

  broadcast({ t:'state', now,
    players: [...players.entries()].map(([pid,p]) => ({
      id: pid, name: p.name, x: Math.round(p.x), y: Math.round(p.y),
      hp: Math.round(p.hp), maxHp: p.maxHp, mp: Math.round(p.mp), maxMp: p.maxMp,
      level: p.level, exp: p.exp, expNeed: expNeed(p.level),
      job: p.job, dead: p.respawnAt > now })),   // job은 공개(외형). 魂/인벤은 사적 — t:self로만
    monsters: [...monsters.entries()].map(([mid,m]) => ({
      id: mid, x: Math.round(m.x), y: Math.round(m.y), hp: m.hp, maxHp: m.maxHp, tier: m.tier, boss: !!m.boss, dying: !!m.dying })),
    souls: [...souls.entries()].map(([sid,s]) => ({
      id: sid, x: Math.round(s.x), y: Math.round(s.y), amount: s.amount,
      locked: now < s.unlockAt, ownerId: s.ownerId })),
    drops: [...drops.entries()].map(([did,d]) => ({
      id: did, x: Math.round(d.x), y: Math.round(d.y), key: d.key,
      locked: now < d.unlockAt, ownerId: d.ownerId })),
  });
}, TICK);

function killMonster(mo, now){
  if(mo.dying) return;   // 한 번만 처리
  let topPid = null, topDmg = -1;
  for(const [pid, dmg] of mo.damage){
    if(dmg > topDmg){ topDmg = dmg; topPid = pid; }
  }

  // 경험치 일괄 지급: 총량은 tier 비례, 접속 중 기여자에게 누적 피해 비율대로 배분.
  // 반올림 잔차는 소수부가 큰 순서로 1씩 나눠, 합계가 정확히 totalExp가 되게 한다(최대잔여법).
  const totalExp = mo.boss ? mo.tier * 50 : mo.tier * 20;
  const contrib = []; let presentDmg = 0;
  for(const [pid, dmg] of mo.damage){
    const pl = players.get(pid);
    if(pl){ contrib.push({ pid, pl, dmg }); presentDmg += dmg; }
  }
  if(presentDmg > 0){
    let assigned = 0;
    for(const c of contrib){ c.exact = totalExp * c.dmg / presentDmg; c.base = Math.floor(c.exact); assigned += c.base; }
    contrib.sort((a, b) => (b.exact - b.base) - (a.exact - a.base));
    let leftover = totalExp - assigned;
    for(let i = 0; i < contrib.length && leftover > 0; i++){ contrib[i].base++; leftover--; }
    for(const c of contrib){ if(c.base > 0) grantExp(c.pl, c.pid, c.base); }
  }

  const amount = mo.boss ? 70 : mo.tier * 5;
  souls.set(nid('s'), {
    x: mo.x, y: mo.y, amount,
    ownerId: topPid,
    unlockAt: now + SOUL_PRIORITY_MS,
    expireAt: now + 60000,
  });

  // 장비 드랍: 잡몹은 상점급을 저확률(8%), 보스는 고급 직업 장비를 낮은 확률(20%)로
  let pool = mo.boss ? BOSS_DROPS : COMMON_DROPS;
  if(mo.boss){   // 보스 드랍은 최다 기여자의 직업 장비로 보정
    const kp = topPid && players.get(topPid);
    if(kp && kp.job){ const jp = BOSS_DROPS.filter(k => EQUIP[k].job === kp.job); if(jp.length) pool = jp; }
  }
  const chance = mo.boss ? 0.20 : 0.08;
  if(pool.length && Math.random() < chance){
    const key = pool[Math.floor(rnd(pool.length))];
    drops.set(nid('d'), {
      x: mo.x + rnd(20) - 10, y: mo.y + rnd(20) - 10, key,
      ownerId: topPid, unlockAt: now + SOUL_PRIORITY_MS, expireAt: now + 90000,
    });
    if(topPid){ const tp = players.get(topPid); if(tp) send(tp.ws, { t:'msg', k:'g', text:`${EQUIP[key].name}을(를) 떨어뜨렸다!` }); }
  }

  // 즉시 제거하지 않고 사망 연출 동안 잔존 — 실제 제거는 틱 루프가 dieAt에 처리
  mo.dying = true;
  mo.dieAt = now + DEATH_MS;
  mo.aggroId = null;
  if(mo.boss) setTimeout(spawnBoss, 45000);          // 보스는 처치 후 한참 뒤에 부활
  else setTimeout(spawnMonster, 3000 + rnd(4000));
}

httpServer.listen(PORT, () => console.log(`[魂] 세계 가동 — http://localhost:${PORT}`));
