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
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

// ---------- 영속성: Supabase (서버에서만 접근, 키는 환경변수로만) ----------
// 환경변수 SUPABASE_URL / SUPABASE_SERVICE_KEY 가 있어야 영속성이 켜진다.
// 없으면 메모리 전용으로 동작(개발/장애 시 graceful degradation). 키는 절대 클라이언트로 보내지 않는다.
let supabase = null;
{
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if(url && key){
    try{
      const { createClient } = require('@supabase/supabase-js');
      supabase = createClient(url, key, { auth: { persistSession:false, autoRefreshToken:false } });
      console.log('[魂] Supabase 연결 — 캐릭터 영속성 활성화');
    }catch(e){ console.error('[魂] Supabase 초기화 실패, 메모리 전용으로 진행:', e.message); supabase = null; }
  } else {
    console.warn('[魂] SUPABASE_URL/SUPABASE_SERVICE_KEY 미설정 — 메모리 전용(재시작 시 캐릭터 소멸)');
  }
}

const PORT = process.env.PORT || 8787;
const TICK = 50;
const WORLD = 1600;
const PLAYER_SPEED = 170;
const ATTACK_CD = 600;
const MONSTER_COUNT = 24;
const SOUL_PRIORITY_MS = 5000;
const TRADE_RANGE = 100;       // 거래 신청/수락 허용 거리
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

// ---------- 보스(고정 구역·리스폰) + 미션 정의 (데이터로 분리 — 보스 추가가 쉽게) ----------
// 월드 고정 위치에 실존, 모두에게 보이고 누구나 공격 가능. 일반 몹보다 크고 강하며 체력 많음.
const BOSS_DEFS = {
  ogre:    { name:'붉은 도깨비', x:1300, y:300, hp:1000, atk:26, size:26, color:'#a3402f', soulDrop:120, xp:160, respawnMs:120000 },
  serpent: { name:'구렁이 王',   x:300,  y:340, hp:2000, atk:40, size:31, color:'#3a7a4a', soulDrop:240, xp:320, respawnMs:150000 },
  oni:     { name:'대오니 鬼神', x:820,  y:150, hp:3400, atk:56, size:37, color:'#7a3a8a', soulDrop:420, xp:640, respawnMs:180000 },
};
// 미션: 해당 레벨 도달 시 발생. 보스 처치 '기여(피해 기록)'가 있으면 완료(막타 무관). 보상=혼 대량 + 구간 장비.
const MISSIONS = [
  { key:'ogre',    boss:'ogre',    reqLevel:10, name:'붉은 도깨비', hint:'북동쪽',   soul:200, gear:{ warrior:['hwando'], onmyoji:['talisman'], archer:['longbow'], any:['bspear'] } },
  { key:'serpent', boss:'serpent', reqLevel:15, name:'구렁이 王',   hint:'북서쪽',   soul:450, gear:{ warrior:['armor'],  onmyoji:['dopo'],     archer:['leatherrobe'], any:['leathervest'] } },
  { key:'oni',     boss:'oni',     reqLevel:20, name:'대오니 鬼神', hint:'북쪽 중앙', soul:900, gear:{ warrior:['armor','hwando'], onmyoji:['dopo','talisman'], archer:['leatherrobe','longbow'], any:['sakkat'] } },
];
const MISSION_DEFS_CLIENT = MISSIONS.map(m => ({ key:m.key, name:m.name, reqLevel:m.reqLevel, soul:m.soul, hint:m.hint }));
function ensureMissions(p){   // 도달 레벨의 미션을 활성화(중복 없이) — 새로 켜진 정의 배열 반환
  const added = [];
  for(const md of MISSIONS){ if(p.level >= md.reqLevel && !p.missions[md.key]){ p.missions[md.key] = 'active'; added.push(md); } }
  return added;
}

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
const joining = new Set(); // 입장 처리 중인 이름(동시 접속/생성 경쟁 방지)
let nextId = 1;
const nid = (p) => p + (nextId++);

function rnd(n){ return Math.random()*n; }
function dist(a,b){ return Math.hypot(a.x-b.x, a.y-b.y); }
function spawnPos(){ return { x: VILLAGE.x - 60 + rnd(120), y: VILLAGE.y - 40 + rnd(80) }; }
function nameOnline(name){ for(const pl of players.values()) if(pl.name === name) return true; return false; }

// ---------- 비밀번호 해시 (salt$scrypt) ----------
function hashPassword(pw){
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return salt + '$' + hash;
}
function verifyPassword(pw, stored){
  if(typeof stored !== 'string' || !stored.includes('$')) return false;
  const [salt, hash] = stored.split('$');
  let h; try{ h = crypto.scryptSync(String(pw), salt, 32).toString('hex'); }catch(e){ return false; }
  const a = Buffer.from(h, 'hex'), b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- 캐릭터 ↔ DB 매핑 ----------
function applyJobDerived(p){   // range/speed는 직업에서 파생(저장하지 않음)
  if(p.job && JOBS[p.job]){ p.range = JOBS[p.job].range; p.speed = JOBS[p.job].speed; }
  else { p.range = 34; p.speed = PLAYER_SPEED; }
}
function baseRuntime(){ return { tx:null, ty:null, lastAtk:0, respawnAt:0, attackId:null, lastDamagedAt:0, jobOffered:false }; }
function makeNewChar(ws, name, pwhash){
  const s = spawnPos();
  return { ws, name, pw: pwhash, ...baseRuntime(),
    x: s.x, y: s.y,
    hp: 60, maxHp: 60, mp: 30, maxMp: 30, atk: 7, range: 34, speed: PLAYER_SPEED,
    level: 1, exp: 0, soul: 0, job: null, missions: {},
    inv: new Set(['scythe','hemprobe','straw']),
    equip: { ...START_GEAR } };
}
const num = (v, d) => Number.isFinite(Number(v)) ? Number(v) : d;   // 유한수만 채택(0 보존, NULL/NaN은 기본값)
function makeCharFromRow(ws, row){
  // 장비: 슬롯별로 EQUIP 고유 키이고 슬롯이 맞을 때만 채택(손상/위조 행 방어)
  const equip = { weapon:null, body:null, feet:null, head:null };
  const src = (row.equip && typeof row.equip === 'object' && !Array.isArray(row.equip)) ? row.equip : START_GEAR;
  for(const s of SLOTS){ const k = src[s]; if(typeof k === 'string' && eqOf(k) && EQUIP[k].slot === s) equip[s] = k; }
  const inv = Array.isArray(row.inv) ? row.inv.filter(k => typeof k === 'string' && eqOf(k)) : ['scythe','hemprobe','straw'];
  const missions = {};   // 알려진 미션 키 + 유효 상태만 채택
  if(row.missions && typeof row.missions === 'object' && !Array.isArray(row.missions)){
    for(const md of MISSIONS){ const v = row.missions[md.key]; if(v === 'active' || v === 'done') missions[md.key] = v; }
  }
  let x = num(row.x, NaN), y = num(row.y, NaN);
  if(!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)){ const s = spawnPos(); x = s.x; y = s.y; }
  x = Math.max(20, Math.min(WORLD-20, x)); y = Math.max(20, Math.min(WORLD-20, y));
  const p = { ws, name: row.name, pw: row.pw, ...baseRuntime(),
    x, y,
    maxHp: num(row.maxhp, 60), maxMp: num(row.maxmp, 30), atk: num(row.atk, 7),
    level: num(row.level, 1), exp: num(row.exp, 0), soul: num(row.soul, 0), job: row.job || null, missions,
    inv: new Set(inv), equip };
  applyJobDerived(p);
  p.hp = Math.max(1, Math.min(p.maxHp, num(row.hp, p.maxHp)));   // 범위 보정(살아있게)
  p.mp = Math.max(0, Math.min(p.maxMp, num(row.mp, p.maxMp)));
  const need = expNeed(p.level);                                  // exp가 현재 레벨 요구치를 넘지 않게 정규화
  if(p.exp >= need) p.exp = need - 1;
  if(p.exp < 0) p.exp = 0;
  return p;
}
function rowOf(p){   // 저장용(비밀번호 제외 — pw는 별도 처리)
  return {
    name: p.name,
    level: p.level, exp: Math.round(p.exp), soul: Math.round(p.soul),
    hp: Math.max(1, Math.round(p.hp)), mp: Math.max(0, Math.round(p.mp)),   // 죽은 상태(<=0)로 저장돼 부활 악용되지 않게 최소 1
    maxhp: p.maxHp, maxmp: p.maxMp, atk: p.atk,
    job: p.job, equip: p.equip, inv: [...p.inv], missions: p.missions,
    x: Math.round(p.x), y: Math.round(p.y),
    updated_at: new Date().toISOString(),
  };
}
async function writeChar(p){   // 실제 기록(upsert): 행이 없어도 복구 생성, pw 보존
  const { error } = await supabase.from('characters').upsert({ ...rowOf(p), pw: p.pw }, { onConflict: 'name' });
  if(error) throw error;
}
async function saveChar(p){   // 캐릭터별 직렬화 + 폭주 합치기(겹치는 UPDATE의 순서 역전 방지)
  if(!supabase || !p || !p.name) return;
  if(p._saving){ p._saveAgain = true; return; }
  p._saving = true;
  try{ await writeChar(p); }
  catch(e){ console.error('[魂] 저장 실패', p.name, e.message); }
  finally{ p._saving = false; if(p._saveAgain){ p._saveAgain = false; saveChar(p); } }
}

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
function spawnMissionBoss(key){
  const d = BOSS_DEFS[key]; if(!d) return;
  monsters.set(nid('m'), {
    x: d.x, y: d.y, homeX: d.x, homeY: d.y,
    tier: 4, boss: true, bossKey: key, name: d.name, color: d.color, r: d.size,
    hp: d.hp, maxHp: d.hp, atk: d.atk, soulDrop: d.soulDrop, xp: d.xp, respawnMs: d.respawnMs,
    wander: rnd(Math.PI*2), aggroId: null,
    damage: new Map(), lastHitAt: 0, dying: false, dieAt: 0,
  });
}
for(let i=0;i<MONSTER_COUNT;i++) spawnMonster();
for(const k of Object.keys(BOSS_DEFS)) spawnMissionBoss(k);

// ---------- WebSocket: 같은 서버에 부착 ----------
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  const id = nid('p');
  ws.on('message', async (raw) => {
    let m; try{ m = JSON.parse(raw); }catch(e){ return; }

    if(m.t === 'join'){
      if(players.has(id)) return;                         // 이 연결은 이미 입장함
      const name = String(m.name||'').trim().slice(0,10);
      const pw = String(m.pw||'');
      if(name.length < 1 || pw.length < 1){ send(ws,{t:'loginfail',reason:'이름과 비밀번호를 입력하라'}); return; }
      if(pw.length > 64){ send(ws,{t:'loginfail',reason:'비밀번호가 너무 길다'}); return; }   // 과대 입력 KDF DoS 방지
      if(nameOnline(name) || joining.has(name)){ send(ws,{t:'loginfail',reason:'이미 접속 중인 이름이다'}); return; }
      joining.add(name);   // 처리 동안 이름 예약 → 동시 접속/생성 경쟁을 구조적으로 차단
      try{
        let row = null;
        if(supabase){
          try{
            const { data, error } = await supabase.from('characters').select('*').eq('name', name).limit(1);
            if(error) throw error;
            row = (data && data[0]) ? data[0] : null;
          }catch(e){ console.error('[魂] 불러오기 실패', name, e.message); send(ws,{t:'loginfail',reason:'저장소 오류 — 잠시 후 다시 시도'}); return; }
        }
        if(ws.readyState !== ws.OPEN || players.has(id)) return;   // await 사이 끊김

        let p;
        if(row){
          if(!verifyPassword(pw, row.pw)){ send(ws,{t:'loginfail',reason:'비밀번호가 틀렸다'}); return; }
          p = makeCharFromRow(ws, row);
        } else {
          p = makeNewChar(ws, name, hashPassword(pw));
          if(supabase && ws.readyState === ws.OPEN){
            try{ const { error } = await supabase.from('characters').insert({ ...rowOf(p), pw: p.pw }); if(error) throw error; }
            catch(e){ console.error('[魂] 생성 실패', name, e.message); send(ws,{t:'loginfail',reason:'이미 쓰이는 이름이거나 저장소 오류'}); return; }
          }
        }
        if(ws.readyState !== ws.OPEN || players.has(id)) return;   // 최종 확인(연결 끊김/중복)
        players.set(id, p);
        const addedM = ensureMissions(p);   // 불러온 캐릭터가 이미 도달한 미션을 활성화(패널에 표시됨)
        ws.send(JSON.stringify({ t:'welcome', id, world: WORLD,
          village: VILLAGE, equipDefs: EQUIP, shop: SHOP_KEYS, missionDefs: MISSION_DEFS_CLIENT }));
        sendSelf(p);
        if(addedM.length) saveChar(p);   // 새로 활성화된 미션 즉시 저장
        if(p.level >= 5 && !p.job){ p.jobOffered = true; send(ws, { t:'canjob' }); }   // 이미 전직 자격이면 안내
      } finally {
        joining.delete(name);   // 이름 예약 해제(성공/실패 무관)
      }
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
        saveChar(p);   // 혼은 주요 재화 — 획득 즉시 저장(합치기됨)
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
        saveChar(p);   // 장비 획득 직후 저장
      } else if(!canLoot && dist(p,d) < 40){
        send(p.ws, { t:'msg', k:'b', text:'아직 임자가 있는 전리품이다 (5초 후 풀린다)' });
      }
    }
    if(m.t === 'equip'){
      if(p.trade){ send(p.ws,{t:'msg',k:'b',text:'거래 중에는 장비를 바꿀 수 없다'}); return; }
      const key = m.key, it = eqOf(key);
      if(it && p.inv.has(key) && (!it.job || it.job === p.job)){   // 직업 제한 장비는 해당 직업만
        p.equip[it.slot] = key;
        sendSelf(p);
      }
    }
    if(m.t === 'unequip'){
      if(p.trade){ send(p.ws,{t:'msg',k:'b',text:'거래 중에는 장비를 바꿀 수 없다'}); return; }
      if(SLOTS.includes(m.slot) && p.equip[m.slot]){
        p.equip[m.slot] = null;
        sendSelf(p);
      }
    }
    if(m.t === 'buy'){
      if(p.trade){ send(p.ws,{t:'msg',k:'b',text:'거래 중에는 구매할 수 없다'}); return; }
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
      saveChar(p);   // 구매 직후 저장
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
        saveChar(p);   // 전직 직후 저장
      }
    }

    // ===== 거래(서버 원자 처리) =====
    if(m.t === 'trade_req'){
      if(p.trade){ send(p.ws,{t:'msg',k:'b',text:'이미 거래 중이다'}); return; }
      const tp = players.get(m.id);
      if(!tp || tp === p) return;
      if(tp.trade){ send(p.ws,{t:'msg',k:'b',text:'상대가 거래 중이다'}); return; }
      if(p.respawnAt > Date.now() || tp.respawnAt > Date.now()) return;
      if(dist(p, tp) > TRADE_RANGE){ send(p.ws,{t:'msg',k:'b',text:'거래하려면 더 가까이 가라'}); return; }
      tp._invite = { from: id, at: Date.now() };
      send(tp.ws, { t:'trade_invite', from: id, name: p.name });
      send(p.ws, { t:'msg', k:'g', text:`${tp.name}에게 거래를 청했다` });
    }
    if(m.t === 'trade_decline'){
      if(p._invite && p._invite.from === m.id){ const fp = players.get(m.id); p._invite = null; if(fp) send(fp.ws,{t:'msg',k:'b',text:`${p.name}이(가) 거래를 거절했다`}); }
    }
    if(m.t === 'trade_accept'){
      if(!p._invite || p._invite.from !== m.id || Date.now() - p._invite.at > 30000){ p._invite = null; return; }
      const fp = players.get(m.id); p._invite = null;
      if(!fp || fp.trade || p.trade){ send(p.ws,{t:'msg',k:'b',text:'거래를 시작할 수 없다'}); return; }
      if(dist(p, fp) > TRADE_RANGE){ send(p.ws,{t:'msg',k:'b',text:'상대가 너무 멀다'}); return; }
      const trade = { a: m.id, b: id, offerA:{soul:0,items:[]}, offerB:{soul:0,items:[]}, confA:false, confB:false, done:false };
      fp.trade = trade; p.trade = trade;
      send(fp.ws, { t:'trade_open', withName: p.name });
      send(p.ws,  { t:'trade_open', withName: fp.name });
      sendTradeState(trade);
    }
    if(m.t === 'trade_offer'){
      const trade = p.trade; if(!trade || trade.done) return;
      const mine = (trade.a === id) ? trade.offerA : trade.offerB;
      const partner = players.get(trade.a === id ? trade.b : trade.a);
      // 내 소유 + 상대가 아직 안 가진 것만 (상대가 이미 가진 키를 건네면 소멸하므로 제외)
      const items = Array.isArray(m.items) ? [...new Set(m.items.filter(k => typeof k === 'string' && p.inv.has(k) && !(partner && partner.inv.has(k))))].slice(0,12) : [];
      let soul = Math.floor(num(m.soul, 0)); if(!(soul >= 0)) soul = 0; if(soul > p.soul) soul = p.soul;
      mine.soul = soul; mine.items = items;
      trade.confA = false; trade.confB = false;   // 제안이 바뀌면 양쪽 확정 해제(스캠 방지)
      sendTradeState(trade);
    }
    if(m.t === 'trade_confirm'){
      const trade = p.trade; if(!trade || trade.done) return;
      if(trade.a === id) trade.confA = true; else trade.confB = true;
      sendTradeState(trade);
      if(trade.confA && trade.confB) executeTrade(trade);   // 둘 다 확정 시에만 원자 체결
    }
    if(m.t === 'trade_cancel'){
      if(p.trade) cancelTrade(p.trade, '거래가 취소되었다');
    }
  });
  ws.on('close', () => {
    const p = players.get(id);
    if(p){ if(p.trade) cancelTrade(p.trade, '상대가 접속을 종료했다'); saveChar(p); }   // 거래 취소 + 종료 저장
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
    job: p.job, speed: p.speed, range: p.range, missions: p.missions });
}

// ---------- 거래: 상태 송신 / 취소 / 검증 / 원자 체결 ----------
function offerView(offer, conf, name){ const v = { soul: offer.soul, items: offer.items.slice(), confirmed: conf }; if(name !== undefined) v.name = name; return v; }
function sendTradeState(trade){
  const A = players.get(trade.a), B = players.get(trade.b);
  if(A) send(A.ws, { t:'trade_state', mine: offerView(trade.offerA, trade.confA), theirs: offerView(trade.offerB, trade.confB, B ? B.name : '') });
  if(B) send(B.ws, { t:'trade_state', mine: offerView(trade.offerB, trade.confB), theirs: offerView(trade.offerA, trade.confA, A ? A.name : '') });
}
function cancelTrade(trade, reason){
  if(!trade) return;
  const A = players.get(trade.a), B = players.get(trade.b);
  if(A && A.trade === trade){ A.trade = null; send(A.ws, { t:'trade_cancel', reason }); }
  if(B && B.trade === trade){ B.trade = null; send(B.ws, { t:'trade_cancel', reason }); }
}
function validOffer(p, offer){   // 체결 직전 재검증: 혼/아이템을 실제로 보유하는가
  if(!Number.isInteger(offer.soul) || offer.soul < 0 || offer.soul > p.soul) return false;
  for(const k of offer.items){ if(!p.inv.has(k)) return false; }
  return true;
}
function executeTrade(trade){
  if(trade.done) return;   // 중복/재전송 체결 차단
  const A = players.get(trade.a), B = players.get(trade.b);
  if(!A || !B){ cancelTrade(trade, '상대가 사라졌다'); return; }
  if(A.trade !== trade || B.trade !== trade){ cancelTrade(trade, '거래가 무산됐다'); return; }   // 포인터 정합성(방어)
  if(!validOffer(A, trade.offerA) || !validOffer(B, trade.offerB)){ cancelTrade(trade, '물품이 바뀌어 거래가 무산됐다'); return; }
  // 받는 쪽이 이미 가진 물품(같은 키)은 건넬 수 없다 — 건네면 Set 특성상 한쪽 물품이 소멸한다
  for(const k of trade.offerA.items){ if(B.inv.has(k)){ cancelTrade(trade, '상대가 이미 지닌 물품은 건넬 수 없다'); return; } }
  for(const k of trade.offerB.items){ if(A.inv.has(k)){ cancelTrade(trade, '상대가 이미 지닌 물품은 건넬 수 없다'); return; } }
  trade.done = true;   // 검증 통과 후 잠금 — 이 지점부터 동기적·원자적으로 양도(중간 await 없음 = 부분 상태 불가능)
  const give = (from, to, offer) => {
    from.soul -= offer.soul; to.soul += offer.soul;
    for(const k of offer.items){
      from.inv.delete(k);
      for(const s of SLOTS){ if(from.equip[s] === k) from.equip[s] = null; }   // 넘긴 장비가 착용 중이면 해제
      to.inv.add(k);
    }
  };
  give(A, B, trade.offerA);
  give(B, A, trade.offerB);
  A.trade = null; B.trade = null;
  send(A.ws, { t:'trade_done' }); send(B.ws, { t:'trade_done' });
  send(A.ws, { t:'msg', k:'g', text:'거래 성사' }); send(B.ws, { t:'msg', k:'g', text:'거래 성사' });
  sendSelf(A); sendSelf(B);
  saveChar(A); saveChar(B);   // 체결 즉시 양쪽 DB 저장
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
  if(leveled){
    const added = ensureMissions(p);   // 레벨 10/15/20 도달 시 해당 보스 미션 발생
    for(const md of added){ send(p.ws, { t:'mission', kind:'new', key:md.key, name:md.name, reqLevel:md.reqLevel,
      text:`[미션] ${md.name} 토벌 — ${md.hint} 구역의 보스를 처치하라` }); }
    sendSelf(p); saveChar(p);   // 능력치/미션 갱신 + 저장
  }
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
      const reach = mo.boss ? (mo.r ? mo.r + 8 : 30) : 22;   // 큰 보스는 조금 더 멀리서 타격
      // 마을로 달아나거나(안전지대) 너무 멀거나, 보스가 제 구역에서 너무 벗어나면 추격 포기
      if(d > 600 || dist(tgt, VILLAGE) < VILLAGE.r || (mo.homeX != null && Math.hypot(mo.x-mo.homeX, mo.y-mo.homeY) > 520)){ mo.aggroId = null; }
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
          if(tgt.trade) cancelTrade(tgt.trade, '상대가 쓰러져 거래가 취소되었다');   // 사망 시 거래 취소
          sendSelf(tgt);   // 흘린 魂 반영
          saveChar(tgt);   // 사망 손실(혼/위치) 저장
          // 죽은 자를 쫓던 모든 요괴의 어그로를 푼다 (부활 직후 마을까지 쫓아오지 않도록)
          for(const om of monsters.values()){ if(om.aggroId === deadPid) om.aggroId = null; }
        }
      }
    } else if(mo.homeX != null){
      // 고정 구역 보스: 어그로가 없으면 제 자리로 천천히 복귀
      const hd = Math.hypot(mo.x-mo.homeX, mo.y-mo.homeY);
      if(hd > 8){ const sp=(40+mo.tier*14)*dt; mo.x += (mo.homeX-mo.x)/hd*sp; mo.y += (mo.homeY-mo.y)/hd*sp; }
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
      id: mid, x: Math.round(m.x), y: Math.round(m.y), hp: m.hp, maxHp: m.maxHp, tier: m.tier, boss: !!m.boss, dying: !!m.dying,
      name: m.name || null, color: m.color || null, r: m.r || 0 })),
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

  // 미션 완료 판정 스냅샷: '이번 킬 이전에' 활성이던 기여자만 인정
  // (아래 grantExp가 이 킬로 레벨업시켜 막 활성화한 미션이 같은 킬에 즉시 완료되는 것을 방지)
  const bdef = mo.bossKey ? MISSIONS.find(x => x.boss === mo.bossKey) : null;
  const missionActiveBefore = new Set();
  if(bdef){ for(const pid of mo.damage.keys()){ const pl = players.get(pid); if(pl && pl.missions[bdef.key] === 'active') missionActiveBefore.add(pid); } }

  // 경험치 일괄 지급: 총량은 tier 비례, 접속 중 기여자에게 누적 피해 비율대로 배분.
  // 반올림 잔차는 소수부가 큰 순서로 1씩 나눠, 합계가 정확히 totalExp가 되게 한다(최대잔여법).
  const totalExp = mo.boss ? (mo.xp || mo.tier * 50) : mo.tier * 20;
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

  const amount = mo.boss ? (mo.soulDrop || 70) : mo.tier * 5;
  souls.set(nid('s'), {   // 혼 드랍: 최다 딜러 5초 우선권(기존 규칙 그대로)
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

  // ===== 보스 미션 완료: 피해 기여자 전원(막타 무관), 단 이번 킬 이전에 활성이던 자만 =====
  if(bdef){
    for(const pid of missionActiveBefore){
      const pl = players.get(pid);
      if(!pl || pl.missions[bdef.key] !== 'active') continue;
      pl.missions[bdef.key] = 'done';
      pl.soul += bdef.soul;
      const lists = [];   // 직업 전용 → 없거나 다 가졌으면 공용에서 보충
      if(pl.job && bdef.gear[pl.job]) lists.push(bdef.gear[pl.job]);
      if(bdef.gear.any) lists.push(bdef.gear.any);
      let got = null;
      for(const list of lists){ for(const gk of list){ if(eqOf(gk) && !pl.inv.has(gk)){ pl.inv.add(gk); got = gk; break; } } if(got) break; }
      send(pl.ws, { t:'mission', kind:'done', key:bdef.key, name:bdef.name,
        text:`[미션 완료] ${bdef.name} 토벌! +${bdef.soul} 魂${got ? ` · ${EQUIP[got].name} 획득` : ''}` });
      sendSelf(pl);
      saveChar(pl);   // 미션 완료 즉시 저장
    }
  }

  // 즉시 제거하지 않고 사망 연출 동안 잔존 — 실제 제거는 틱 루프가 dieAt에 처리
  mo.dying = true;
  mo.dieAt = now + DEATH_MS;
  mo.aggroId = null;
  if(mo.boss){ if(mo.bossKey) setTimeout(() => spawnMissionBoss(mo.bossKey), mo.respawnMs || 120000); }   // 고정 보스는 제 주기로 부활
  else setTimeout(spawnMonster, 3000 + rnd(4000));
}

// ---------- 30초마다 접속자 전원 자동 저장 ----------
setInterval(() => { for(const p of players.values()) saveChar(p); }, 30000);

// 종료 신호 시 전원 저장 후 종료 (Railway 재배포/스케일다운 대비)
let shuttingDown = false;
async function gracefulExit(){
  if(shuttingDown) return; shuttingDown = true;
  if(supabase){ try{ await Promise.allSettled([...players.values()].map(p => writeChar(p).catch(()=>{}))); }catch(e){} }
  process.exit(0);
}
process.on('SIGTERM', gracefulExit);
process.on('SIGINT', gracefulExit);

httpServer.listen(PORT, () => console.log(`[魂] 세계 가동 — http://localhost:${PORT}`));
