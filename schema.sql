-- ============================================================
-- 魂 (혼) — 캐릭터 영속성 테이블
-- 사용법: Supabase 대시보드 → SQL Editor 에 이 파일 전체를 붙여넣고 [Run].
-- 서버는 service_role 키로만 접근합니다(RLS 우회). anon/public 키로는 접근 불가합니다.
-- ============================================================

create table if not exists public.characters (
  name        text primary key,                          -- 캐릭터 이름(고유, 로그인 식별자)
  pw          text not null,                             -- 비밀번호 해시 (salt$scrypt). 평문 저장 금지
  level       integer not null default 1,
  exp         integer not null default 0,
  soul        bigint  not null default 0,                -- 혼(재화)
  hp          integer not null default 60,
  mp          integer not null default 30,
  maxhp       integer not null default 60,
  maxmp       integer not null default 30,
  atk         integer not null default 7,
  job         text,                                      -- null=천민, 'warrior' | 'onmyoji' | 'archer'
  equip       jsonb   not null default '{"weapon":"scythe","body":"hemprobe","feet":"straw","head":null}'::jsonb,
  inv         jsonb   not null default '["scythe","hemprobe","straw"]'::jsonb,
  missions    jsonb   not null default '{}'::jsonb,        -- 보스 미션 진행상태 { ogre:'active'|'done', ... }
  x           double precision not null default 0,        -- 마지막 위치
  y           double precision not null default 0,
  updated_at  timestamptz not null default now()
);

-- 기존 테이블에 missions 열이 없으면 추가(이미 테이블을 만든 경우 이 한 줄만 실행해도 됨)
alter table public.characters add column if not exists missions jsonb not null default '{}'::jsonb;

-- RLS 활성화: 정책을 하나도 두지 않으므로 anon/public 키로는 어떤 행도 읽거나 쓸 수 없습니다.
-- 서버가 쓰는 service_role 키는 RLS를 우회하므로 정상 동작합니다(키는 절대 클라이언트에 노출 금지).
alter table public.characters enable row level security;

-- 최근 저장 순 조회용(선택)
create index if not exists characters_updated_at_idx on public.characters (updated_at desc);
